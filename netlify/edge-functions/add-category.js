// add-category.js

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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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
 * Sanitizes and validates the data received in the request.
 * @param {Object} data - Request data.
 * @returns {Object} Sanitized data.
 * @throws {Error} If the data is not valid.
 */
const sanitizeData = (data) => {
  const sanitizedName = validator.escape(validator.trim(data.name));
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
 * Validates the request data.
 * @param {Object} requestData - Request data.
 * @throws {Error} If the data is not valid.
 */
const validateRequestData = (requestData) => {
  if (!requestData || typeof requestData !== "object") {
    throw new Error("Invalid request data");
  }

  const { name, user_id } = requestData;

  if (!name || user_id === undefined || user_id === null) {
    throw new Error("Fields 'name', 'image', and 'user_id' are required");
  }

  if (!validator.isLength(name, { min: 1, max: 100 })) {
    throw new Error("Name must be between 1 and 100 characters");
  }

  // 'user_id' has already been validated as a number in sanitizeData
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
 * Adds a new category to the database.
 * @param {Object} turso - Turso client.
 * @param {string} name - Category name.
 * @param {string} imageUrl - URL of the category's image.
 * @param {number} user_id - ID of the user creating the category.
 * @returns {Promise<Object>} Created category object.
 * @throws {Error} If an error occurs during the transaction.
 */
const addCategory = async (turso, name, imageUrl, user_id) => {
  const tx = await turso.transaction();
  let newCategoryId;

  try {
    const insertResponse = await tx.execute({
      sql: `INSERT INTO categories (name, image, is_active, is_deleted, created_by, edited_by)
            VALUES (?, ?, 1, 0, ?, ?)`,
      args: [name, imageUrl, user_id, user_id],
    });

    newCategoryId = Number(insertResponse.lastInsertRowid);

    const categoryResponse = await tx.execute({
      sql: `SELECT id, name, image, is_active FROM categories WHERE id = ?`,
      args: [newCategoryId],
    });

    const category = categoryResponse.rows[0];

    await tx.execute({
      sql: `INSERT INTO categories_audit (category_id, user_id, action_type, new_values)
            VALUES (?, ?, 'INSERT', ?)`,
      args: [newCategoryId, user_id, JSON.stringify(category)],
    });

    await tx.commit();
    return category;
  } catch (error) {
    console.error("[ERROR] Transaction failed:", error);
    await tx.rollback();
    throw error;
  }
};

/**
 * Handles incoming requests to add a new category.
 * Applies best practices for Turso connections, error handling, and documentation.
 * @param {Request} request - Incoming request object.
 * @returns {Promise<Response>} HTTP response containing the new category data or an error message.
 */
export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let requestData = {}; // Define requestData in the external scope
  const turso = createTursoClient();

  try {
    if (request.method !== "POST") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    // Parse the data using FormData
    const formData = await request.formData();

    // Extract the fields
    const name = formData.get("name");
    const user_id = formData.get("user_id");
    const imageFile = formData.get("image");

    // Validate that the fields exist
    if (!name || !user_id || !imageFile) {
      throw new Error("Fields 'name', 'image', and 'user_id' are required");
    }

    // Sanitize and validate the data
    requestData = sanitizeData({ name, user_id });
    validateRequestData(requestData);

    // Handle the image file
    let imageUrl = "";
    if (imageFile instanceof File) {
      imageUrl = await uploadImageToImageKit(imageFile);
    } else {
      throw new Error("Invalid image file");
    }

    // Update the sanitized data with the uploaded image URL
    requestData.image = imageUrl;

    // Insert the category and wait for the result to get the ID
    const category = await addCategory(
      turso,
      requestData.name,
      requestData.image,
      requestData.user_id
    );

    // Return the new category with id and is_active
    const newCategory = {
      id: category.id,
      name: category.name,
      image: category.image,
      is_active: category.is_active, // Should always be true according to the insertion
    };

    return new Response(JSON.stringify(newCategory), {
      status: 201,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("[ERROR] Failed to create category:", {
      error: error.message,
      category: requestData?.name || "Unknown",
    });

    let status = 500;
    const errorMessage = error.message;

    if (errorMessage.includes("Invalid API key")) status = 403;
    if (
      errorMessage.includes(
        "Fields 'name', 'image', and 'user_id' are required"
      )
    )
      status = 400;
    if (errorMessage === "Method not allowed") status = 405;
    if (errorMessage === "Invalid request data") status = 400;
    if (errorMessage.includes("Unsupported image type")) status = 400;
    if (errorMessage.includes("Image size exceeds")) status = 400;
    if (errorMessage.includes("Invalid image file")) status = 400;
    if (errorMessage.includes("Invalid user ID")) status = 400;

    return new Response(JSON.stringify({ error: errorMessage }), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } finally {
    if (turso) {
      try {
        await turso.execute({ type: "close" });
        console.log("[INFO] Turso connection closed successfully.");
      } catch (closeError) {
        console.error("[ERROR] Failed to close Turso connection:", closeError);
      }
    }
  }
};
