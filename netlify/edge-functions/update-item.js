// update-item.js

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
 * Checks if any updateable fields are provided in the form data.
 * @param {FormData} formData - The form data to check.
 * @returns {boolean} True if any updateable field is provided.
 */
const hasUpdateableFields = (formData) => {
  const updateableFields = [
    "name",
    "description",
    "price",
    "image",
    "is_active",
  ];
  return updateableFields.some((field) => {
    const value = formData.get(field);
    return value !== null && value !== undefined && value !== "";
  });
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
  const sanitizedDescription = data.description
    ? validator.escape(validator.trim(data.description))
    : null;
  const sanitizedUserId = parseInt(data.user_id, 10);

  let sanitizedPrice = null;
  if (data.price !== undefined && data.price !== null && data.price !== "") {
    sanitizedPrice = parseFloat(data.price);
    if (
      isNaN(sanitizedPrice) ||
      !isFinite(sanitizedPrice) ||
      sanitizedPrice < 0
    ) {
      throw new Error("Invalid price");
    }
  }

  if (isNaN(sanitizedUserId)) {
    throw new Error("Invalid user ID");
  }

  return {
    name: sanitizedName,
    description: sanitizedDescription,
    price: sanitizedPrice,
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
  formData.append("fileName", `itm_${imageFile.name}`);
  formData.append(
    "transformation",
    JSON.stringify({ pre: "h-200,w-200,c-at_max,q-80" })
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
 * Updates an item in the database.
 * @param {Object} turso - Turso client.
 * @param {number} id - Item ID.
 * @param {string} name - Item name.
 * @param {string} description - Item description.
 * @param {number} price - Item price.
 * @param {string} image - Item image URL.
 * @param {number} userId - ID of the user performing the update.
 * @param {boolean} isActive - Whether the item is active.
 * @returns {Promise<Object>} Updated item object.
 * @throws {Error} If an error occurs during the transaction.
 */
const updateItem = async (
  turso,
  id,
  name,
  description,
  price,
  image,
  userId,
  isActive
) => {
  const tx = await turso.transaction();

  try {
    const oldItemResponse = await tx.execute({
      sql: "SELECT * FROM items WHERE id = ?",
      args: [id],
    });

    if (!oldItemResponse?.rows?.length) {
      throw new Error("Item not found");
    }

    const oldItem = oldItemResponse.rows[0];

    if (oldItem.is_deleted === 1) {
      throw new Error("Cannot update a deleted item");
    }

    // Only update fields that were provided
    const updates = [];
    const args = [];

    if (name !== null && name !== undefined) {
      updates.push("name = ?");
      args.push(name);
    }

    if (description !== null && description !== undefined) {
      updates.push("description = ?");
      args.push(description);
    }

    if (price !== null && price !== undefined) {
      updates.push("price = ?");
      args.push(price);
    }

    if (image !== null && image !== undefined) {
      updates.push("image = ?");
      args.push(image);
    }

    if (isActive !== null && isActive !== undefined) {
      updates.push("is_active = ?");
      args.push(isActive === "true" || isActive === true ? 1 : 0);
    }

    // Always update edited_by and edited_at
    updates.push("edited_by = ?", "edited_at = datetime('now')");
    args.push(userId);

    // Add item id to args
    args.push(id);

    if (updates.length === 0) {
      return { message: "No updates to be made" };
    }

    await tx.execute({
      sql: `UPDATE items SET ${updates.join(", ")} WHERE id = ?`,
      args: args,
    });

    const updatedItemResponse = await tx.execute({
      sql: `SELECT * FROM items WHERE id = ?`,
      args: [id],
    });

    if (!updatedItemResponse?.rows?.length) {
      throw new Error("Failed to verify item update");
    }

    const updatedItem = updatedItemResponse.rows[0];

    // Add audit record
    await tx.execute({
      sql: `INSERT INTO items_audit 
            (item_id, user_id, action_type, old_values, new_values) 
            VALUES (?, ?, 'UPDATE', ?, ?)`,
      args: [id, userId, JSON.stringify(oldItem), JSON.stringify(updatedItem)],
    });

    await tx.commit();
    return updatedItem;
  } catch (error) {
    console.error("[ERROR] Transaction failed:", error);
    await tx.rollback();
    throw error;
  }
};

/**
 * Handles incoming requests to update an item.
 * @param {Request} request - Incoming request object.
 * @returns {Promise<Response>} HTTP response containing the updated item data or an error message.
 */
export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let requestData;
  let turso;

  try {
    if (request.method !== "PATCH") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    const formData = await request.formData();

    const id = formData.get("id");
    const user_id = formData.get("user_id");

    if (!id || !user_id) {
      throw new Error("Fields 'id' and 'user_id' are required");
    }

    // Early return if no updateable fields are provided
    if (!hasUpdateableFields(formData)) {
      return new Response(
        JSON.stringify({ message: "No updates to be made" }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    requestData = { id, user_id };
    const name = formData.get("name");
    const description = formData.get("description");
    const price = formData.get("price");
    const is_active = formData.get("is_active");
    const imageFile = formData.get("image");

    const sanitizedData = sanitizeData({
      name,
      description,
      price,
      user_id,
    });

    let imageUrl = formData.get("image_url");
    if (imageFile instanceof File) {
      imageUrl = await uploadImageToImageKit(imageFile);
    }

    turso = createTursoClient();

    const item = await updateItem(
      turso,
      id,
      sanitizedData.name,
      sanitizedData.description,
      sanitizedData.price,
      imageUrl,
      sanitizedData.user_id,
      is_active
    );

    if (item.message === "No updates to be made") {
      return new Response(JSON.stringify(item), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }

    return new Response(JSON.stringify(item), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("[ERROR] Failed to update item:", {
      error: error.message,
      item: requestData?.name || "Unknown",
    });

    let status = 500;
    if (error.message.includes("Invalid API key")) status = 403;
    if (error.message.includes("Fields 'id' and 'user_id' are required"))
      status = 400;
    if (error.message === "Method not allowed") status = 405;
    if (error.message === "Item not found") status = 404;
    if (error.message === "Cannot update a deleted item") status = 400;
    if (
      error.message.includes("Invalid ID or user ID") ||
      error.message.includes("Invalid price")
    )
      status = 400;

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
