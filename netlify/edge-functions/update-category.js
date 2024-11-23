// update-category.js

import { createClient } from "https://esm.sh/@libsql/client@0.6.0/web";
import validator from "https://esm.sh/validator@13.7.0";

/**
 * Creates a new Turso client instance.
 * @returns {Object} Turso client.
 */
const createTursoClient = () => {
  return createClient({
    url: Deno.env.get("TURSO_URL"),
    authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
  });
};

/**
 * Obtains the necessary CORS headers for responses.
 * @returns {Object} CORS headers.
 */
const getCorsHeaders = () => {
  const allowedOrigin = Deno.env.get("FORUM_URL");
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
  };
};

/**
 * Validates the API key provided in the headers.
 * @param {string} apiKey - API key to validate.
 * @throws {Error} If the API key is not valid.
 */
const validateApiKey = (apiKey) => {
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (apiKey !== Deno.env.get("API_KEY")) {
    throw new Error("Invalid API key");
  }
};

/**
 * Validates the request data.
 * @param {Object} requestData - Request data.
 * @returns {Object} Sanitized data.
 * @throws {Error} If the data is not valid.
 */
const validateRequestData = (requestData) => {
  if (!requestData || typeof requestData !== "object") {
    throw new Error("Invalid request data");
  }

  const { id, user_id } = requestData;

  if (!id || !user_id) {
    throw new Error("Fields 'id' and 'user_id' are required");
  }

  const sanitizedId = parseInt(id, 10);
  const sanitizedUserId = parseInt(user_id, 10);

  if (isNaN(sanitizedId) || isNaN(sanitizedUserId)) {
    throw new Error("Invalid ID or user ID");
  }

  return { id: sanitizedId, user_id: sanitizedUserId };
};

/**
 * Sanitizes and validates the data received in the request.
 * @param {Object} data - Request data.
 * @returns {Object} Sanitized data.
 * @throws {Error} If the data is not valid.
 */
const sanitizeData = (data) => {
  const sanitizedName = data.name
    ? validator.escape(validator.trim(data.name))
    : null;
  const sanitizedUserId = parseInt(data.user_id, 10);

  if (isNaN(sanitizedUserId)) {
    throw new Error("Invalid user ID");
  }

  return {
    name: sanitizedName,
    user_id: sanitizedUserId,
  };
};

/**
 * Uploads an image to ImageKit and returns the image URL.
 * @param {File} imageFile - Image file to upload.
 * @returns {Promise<string>} URL of the uploaded image.
 * @throws {Error} If an error occurs during the upload.
 */
const uploadImageToImageKit = async (imageFile) => {
  const allowedTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
  ];
  if (!allowedTypes.includes(imageFile.type)) {
    throw new Error("Unsupported image type");
  }

  const maxSize = 1 * 1024 * 1024; // 1 MB
  if (imageFile.size > maxSize) {
    throw new Error("Image size exceeds the maximum limit of 1MB");
  }

  const formData = new FormData();
  formData.append("file", imageFile);
  formData.append("fileName", `cat_${imageFile.name}`);
  formData.append(
    "transformation",
    JSON.stringify({ pre: "h-100,w-100,c-at_max,q-85" })
  );

  const response = await fetch(Deno.env.get("IMAGEKIT_UPLOAD_URL"), {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(
        Deno.env.get("IMAGEKIT_PRIVATE_KEY") + ":"
      )}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("ImageKit Response:", errorText);
    throw new Error(
      `Error uploading image to ImageKit: ${response.statusText} - ${errorText}`
    );
  }

  const data = await response.json();
  return data.url;
};

/**
 * Updates a category in the database.
 * @param {Object} turso - Turso client.
 * @param {number} id - Category ID.
 * @param {string} name - Category name.
 * @param {string} image - Category image URL.
 * @param {number} userId - ID of the user performing the update.
 * @param {boolean} isActive - Whether the category is active.
 * @returns {Promise<Object>} Updated category object.
 * @throws {Error} If an error occurs during the transaction.
 */
const updateCategory = async (turso, id, name, image, userId, isActive) => {
  const tx = await turso.transaction();

  try {
    const oldCategoryResponse = await tx.execute({
      sql: "SELECT * FROM categories WHERE id = ?",
      args: [id],
    });

    if (!oldCategoryResponse?.rows?.length) {
      throw new Error("Category not found");
    }

    const oldCategory = oldCategoryResponse.rows[0];

    if (oldCategory.is_deleted === 1) {
      throw new Error("Cannot update a deleted category");
    }

    const updatedName = name || oldCategory.name;
    const updatedImage = image || oldCategory.image;
    const isActiveInt =
      isActive !== null && isActive !== undefined
        ? isActive === "true" || isActive === true
          ? 1
          : 0
        : oldCategory.is_active;

    // Check if there are no updates to be made
    if (
      updatedName === oldCategory.name &&
      updatedImage === oldCategory.image &&
      isActiveInt === oldCategory.is_active
    ) {
      return new Response(
        JSON.stringify({ message: "No updates to be made" }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    await tx.execute({
      sql: `UPDATE categories 
            SET name = ?, 
                image = ?, 
                is_active = ?, 
                edited_by = ?,
                edited_at = datetime('now')
            WHERE id = ?`,
      args: [updatedName, updatedImage, isActiveInt, userId, id],
    });

    const updatedCategoryResponse = await tx.execute({
      sql: `SELECT * FROM categories WHERE id = ?`,
      args: [id],
    });

    if (!updatedCategoryResponse?.rows?.length) {
      throw new Error("Failed to verify category update");
    }

    const updatedCategory = updatedCategoryResponse.rows[0];

    await tx.execute({
      sql: `INSERT INTO categories_audit 
            (category_id, user_id, action_type, old_values, new_values) 
            VALUES (?, ?, 'UPDATE', ?, ?)`,
      args: [
        id,
        userId,
        JSON.stringify({
          id: oldCategory.id,
          name: oldCategory.name,
          image: oldCategory.image,
          is_active: oldCategory.is_active === 1,
        }),
        JSON.stringify({
          name: updatedName,
          image: updatedImage,
          is_active: isActiveInt === 1,
        }),
      ],
    });

    await tx.commit();
    return updatedCategory;
  } catch (error) {
    console.error("[ERROR] Transaction failed:", error);
    await tx.rollback();
    throw error;
  }
};

/**
 * Handles incoming requests to update a category.
 * Applies best practices for Turso connections, error handling, and documentation.
 * @param {Request} request - Incoming request object.
 * @returns {Promise<Response>} HTTP response containing the updated category data or an error message.
 */
export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let requestData;
  const turso = createTursoClient();

  try {
    if (request.method !== "PATCH") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    const formData = await request.formData();

    const id = formData.get("id");
    const name = formData.get("name");
    const user_id = formData.get("user_id");
    const is_active = formData.get("is_active");
    const imageFile = formData.get("image");

    if (!id || !user_id) {
      throw new Error("Fields 'id' and 'user_id' are required");
    }

    requestData = { id, user_id };
    const sanitizedData = sanitizeData({ name, user_id });

    let imageUrl = formData.get("image_url");
    if (imageFile instanceof File) {
      imageUrl = await uploadImageToImageKit(imageFile);
    }

    console.log("[INFO] Updating category:", {
      id,
      name: sanitizedData.name,
      image: imageUrl,
      user_id: sanitizedData.user_id,
      is_active,
    });

    const category = await updateCategory(
      turso,
      id,
      sanitizedData.name,
      imageUrl,
      sanitizedData.user_id,
      is_active
    );

    console.log("[SUCCESS] Category updated successfully:", {
      id: category.id,
      name: category.name,
    });

    return new Response(JSON.stringify(category), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("[ERROR] Failed to update category:", {
      error: error.message,
      category: requestData?.name || "Unknown",
    });

    let status = 500;
    if (error.message.includes("Invalid API key")) status = 403;
    if (error.message.includes("Fields 'id' and 'user_id' are required"))
      status = 400;
    if (error.message === "Method not allowed") status = 405;
    if (error.message === "Category not found") status = 404;
    if (error.message === "Cannot update a deleted category") status = 400;
    if (error.message === "Invalid ID or user ID") status = 400;

    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } finally {
    if (turso) {
      try {
        // Close connection without parameters
        await turso.close();
        console.log("[INFO] Turso connection closed successfully.");
      } catch (closeError) {
        console.error("[ERROR] Failed to close Turso connection:", {
          name: closeError.name,
          message: closeError.message,
        });
      }
    }
  }
};
