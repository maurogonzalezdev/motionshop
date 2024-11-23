// add-item.js

import { createClient } from "https://esm.sh/@libsql/client@0.6.0/web";
import validator from "https://esm.sh/validator@13.7.0";

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
  const sanitizedDescription = validator.escape(
    validator.trim(data.description)
  );
  const sanitizedPrice = parseFloat(data.price);
  const sanitizedUserId = parseInt(data.user_id, 10);
  const sanitizedCategories = Array.isArray(data.categories)
    ? data.categories.map((id) => parseInt(id, 10))
    : [parseInt(data.categories, 10)];

  if (isNaN(sanitizedPrice) || isNaN(sanitizedUserId)) {
    throw new Error("Invalid price or user ID");
  }

  if (sanitizedCategories.some((id) => isNaN(id))) {
    throw new Error("Invalid category ID format");
  }

  if (sanitizedPrice < 0) {
    throw new Error("Price cannot be negative");
  }

  return {
    name: sanitizedName,
    description: sanitizedDescription,
    price: sanitizedPrice,
    categories: sanitizedCategories,
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

  const { name, description, price, categories, user_id } = requestData;

  if (
    !name ||
    !description ||
    price === undefined ||
    !categories ||
    categories.length === 0 ||
    !user_id
  ) {
    throw new Error(
      "All fields are required: name, description, image, price, categories, and user_id"
    );
  }

  if (!validator.isLength(name, { min: 1, max: 100 })) {
    throw new Error("Name must be between 1 and 100 characters");
  }

  if (!validator.isLength(description, { min: 1, max: 500 })) {
    throw new Error("Description must be between 1 and 500 characters");
  }

  // 'price' and 'user_id' have already been validated as numbers in sanitizeData
};

/**
 * Validates that the categories exist in the database.
 * @param {Object} turso - Turso client.
 * @param {number[]} categories - Category IDs.
 * @throws {Error} If any category does not exist.
 */
const validateCategoriesExist = async (turso, categories) => {
  const placeholders = categories.map(() => "?").join(",");
  const response = await turso.execute({
    sql: `SELECT id FROM categories WHERE id IN (${placeholders}) AND is_deleted = 0`,
    args: categories,
  });

  if (response.rows.length !== categories.length) {
    const foundIds = response.rows.map((row) => row.id);
    const missingIds = categories.filter((id) => !foundIds.includes(id));
    throw new Error(`Categories not found: ${missingIds.join(", ")}`);
  }
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
  formData.append("fileName", `item_${imageFile.name}`);
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
 * Adds a new item to the database.
 * @param {Object} turso - Turso client.
 * @param {string} name - Item name.
 * @param {string} description - Item description.
 * @param {string} imageUrl - URL of the item's image.
 * @param {number} price - Item price.
 * @param {number[]} categories - Associated category IDs.
 * @param {number} userId - ID of the user creating the item.
 * @returns {Promise<Object>} Created item object.
 * @throws {Error} If an error occurs during the transaction.
 */
const addItem = async (
  turso,
  name,
  description,
  imageUrl,
  price,
  categories,
  userId
) => {
  const tx = await turso.transaction();
  let newItemId;

  try {
    await validateCategoriesExist(turso, categories);

    const insertResponse = await tx.execute({
      sql: `INSERT INTO items (
              name, description, price, image, 
              is_active, is_deleted, created_by, edited_by
            ) VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
      args: [name, description, price, imageUrl, userId, userId],
    });

    newItemId = Number(insertResponse.lastInsertRowid);

    for (const categoryId of categories) {
      await tx.execute({
        sql: "INSERT INTO item_categories (category_id, item_id) VALUES (?, ?)",
        args: [categoryId, newItemId],
      });
    }

    const itemResponse = await tx.execute({
      sql: `SELECT * FROM items WHERE id = ?`,
      args: [newItemId],
    });

    if (!itemResponse?.rows?.length) {
      throw new Error("Failed to verify item creation");
    }

    const categoriesResponse = await tx.execute({
      sql: `SELECT category_id FROM item_categories WHERE item_id = ?`,
      args: [newItemId],
    });

    const item = itemResponse.rows[0];
    item.categories = categoriesResponse.rows.map((row) =>
      Number(row.category_id)
    );

    await tx.execute({
      sql: `INSERT INTO items_audit (
              item_id, user_id, action_type, 
              old_values, new_values
            ) VALUES (?, ?, 'INSERT', NULL, ?)`,
      args: [
        newItemId,
        userId,
        JSON.stringify({
          name,
          description,
          image: imageUrl,
          price,
          is_active: true,
          is_deleted: false,
          categories,
        }),
      ],
    });

    await tx.commit();
    return item;
  } catch (error) {
    console.error("[ERROR] Transaction failed:", error);
    await tx.rollback();
    throw error;
  }
};

/**
 * Handles incoming requests to add a new item.
 * @param {Request} request - Incoming request object.
 * @returns {Promise<Response>} HTTP response.
 */
export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let requestData = {}; // Define requestData in the external scope

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
    const description = formData.get("description");
    const price = formData.get("price");
    const categories = formData.getAll("categories"); // Assuming it's an array of IDs
    const user_id = formData.get("user_id");
    const imageFile = formData.get("image");

    // Validate that the fields exist
    if (
      !name ||
      !description ||
      price === null ||
      price === undefined ||
      categories.length === 0 ||
      !user_id ||
      !imageFile
    ) {
      throw new Error(
        "All fields are required: name, description, image, price, categories, and user_id"
      );
    }

    // Sanitize and validate the data
    requestData = sanitizeData({
      name,
      description,
      price,
      categories,
      user_id,
    });
    validateRequestData(requestData);

    // Handle the image file
    let imageUrl = "";
    if (imageFile instanceof File) {
      imageUrl = await uploadImageToImageKit(imageFile);
    } else {
      throw new Error("Invalid image file");
    }

    // Update the sanitized image with the uploaded URL
    requestData.image = imageUrl;

    // Create the Turso client within the handler to avoid "invalid baton"
    const turso = createClient({
      url: Deno.env.get("TURSO_URL"),
      authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
    });

    console.log("[INFO] Creating item:", {
      name: requestData.name,
      description: requestData.description,
      image: requestData.image,
      price: requestData.price,
      categories: requestData.categories,
      user_id: requestData.user_id,
    });

    // Insert the item and wait for the result to get the ID
    const item = await addItem(
      turso,
      requestData.name,
      requestData.description,
      requestData.image,
      requestData.price,
      requestData.categories,
      requestData.user_id
    );

    console.log("[SUCCESS] Item created successfully:", {
      id: item.id,
      name: item.name,
    });

    // Build the response object
    const newItem = {
      id: item.id,
      name: item.name,
      description: item.description,
      image: item.image,
      price: item.price,
      is_active: item.is_active,
      is_deleted: item.is_deleted,
      categories: item.categories,
    };

    return new Response(JSON.stringify(newItem), {
      status: 201,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("[ERROR] Failed to create item:", {
      error: error.message,
      item: requestData.name || "Unknown",
    });

    let status = 500;
    const errorMessage = error.message;

    if (errorMessage.includes("Invalid API key")) status = 403;
    if (errorMessage.includes("All fields are required")) status = 400;
    if (errorMessage === "Method not allowed") status = 405;
    if (errorMessage === "Failed to verify item creation") status = 500;
    if (errorMessage === "Invalid request data") status = 400;
    if (errorMessage.includes("Categories not found")) status = 400;
    if (errorMessage === "Invalid price or user ID") status = 400;
    if (errorMessage === "Invalid category ID format") status = 400;
    if (errorMessage.includes("Unsupported image type")) status = 400;
    if (errorMessage.includes("Image size exceeds")) status = 400;
    if (errorMessage.includes("Invalid image file")) status = 400;

    return new Response(JSON.stringify({ error: errorMessage }), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
};
