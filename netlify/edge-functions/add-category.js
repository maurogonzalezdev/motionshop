import { createClient } from "https://esm.sh/@libsql/client@0.6.0/web";
import validator from "https://esm.sh/validator@13.7.0";

const createTursoClient = () => {
  return createClient({
    url: Deno.env.get("TURSO_URL"),
    authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
  });
};

const getCorsHeaders = () => {
  const allowedOrigin = Deno.env.get("FORUM_URL");
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
  };
};

const validateApiKey = (apiKey) => {
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (apiKey !== Deno.env.get("API_KEY")) {
    throw new Error("Invalid API key");
  }
};

const sanitizeData = (data) => {
  return {
    name: validator.escape(validator.trim(data.name)),
    userId: validator.escape(validator.trim(data.userId)),
  };
};

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

  const transformation = {
    pre: "h-100,w-100,c-at_max,q-85",
  };
  formData.append("transformation", JSON.stringify(transformation));

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
      `Error al subir la imagen a ImageKit: ${response.statusText} - ${errorText}`
    );
  }

  const data = await response.json();
  return data.url;
};

const addCategory = async (turso, name, image, userId) => {
  const tx = await turso.transaction();

  try {
    const insertResponse = await tx.execute({
      sql: "INSERT INTO categories (name, image, is_active, is_deleted, created_by, edited_by) VALUES (?, ?, 1, 0, ?, ?)",
      args: [name, image, userId, userId],
    });

    const newCategoryId = Number(insertResponse.lastInsertRowid);

    const categoryResponse = await tx.execute({
      sql: "SELECT * FROM categories WHERE id = ?",
      args: [newCategoryId],
    });

    if (!categoryResponse?.rows?.length) {
      throw new Error("Failed to verify category creation");
    }

    const category = categoryResponse.rows[0];

    await tx.execute({
      sql: "INSERT INTO categories_audit (category_id, user_id, action_type, old_values, new_values) VALUES (?, ?, 'INSERT', NULL, ?)",
      args: [
        newCategoryId,
        userId,
        JSON.stringify({
          name,
          image,
          is_active: true,
          is_deleted: false,
        }),
      ],
    });

    await tx.commit();
    return category;
  } catch (error) {
    console.error("[ERROR] Transaction failed:", error);
    await tx.rollback();
    throw error;
  }
};

export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (request.method !== "POST") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    const formData = await request.formData();
    const name = formData.get("name");
    const image = formData.get("image");
    const userId = formData.get("user_id");

    if (!name || !image || !userId) {
      throw new Error("All fields are required: user_id, name, and image");
    }

    const sanitizedData = sanitizeData({ name, userId });
    const turso = createTursoClient();

    console.log("[INFO] Subiendo imagen a ImageKit");
    let imageKitImageUrl;
    try {
      imageKitImageUrl = await uploadImageToImageKit(image);
    } catch (uploadError) {
      console.error(
        "[ERROR] Error al subir la imagen a ImageKit:",
        uploadError.message
      );
      throw new Error(
        "Error al subir la imagen a ImageKit: " + uploadError.message
      );
    }

    console.log("[INFO] Creating category:", {
      name: sanitizedData.name,
      image: imageKitImageUrl,
      user_id: sanitizedData.userId,
    });

    const category = await addCategory(
      turso,
      sanitizedData.name,
      imageKitImageUrl,
      sanitizedData.userId
    );

    console.log("[SUCCESS] Category created successfully:", {
      id: category.id,
      name: category.name,
      image: category.image,
    });

    return new Response(JSON.stringify(category), {
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
    if (error.message.includes("Invalid API key")) status = 403;
    if (error.message.includes("All fields are required")) status = 400;
    if (error.message === "Method not allowed") status = 405;
    if (error.message === "Failed to verify category creation") status = 500;
    if (error.message === "Invalid request data") status = 400;

    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
};
