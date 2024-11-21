import { createClient } from "https://esm.sh/@libsql/client@0.6.0/web";

const createTursoClient = () => {
  return createClient({
    url: Deno.env.get("TURSO_URL"),
    authToken: Deno.env.get("TURSO_WRITE_TOKEN"),
  });
};

const getCorsHeaders = () => {
  const allowedOrigin = Deno.env.get("FORUM_URL");
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
};

const validateRequestData = (requestData) => {
  const { name, image, api_key, user_id } = requestData;

  if (!name || !image || !api_key || !user_id) {
    throw new Error(
      "Missing required fields: name, image, api_key, and user_id"
    );
  }

  if (api_key !== Deno.env.get("API_KEY")) {
    throw new Error("Invalid API key");
  }

  return { name, image, user_id };
};

const sanitizeData = (name, image) => {
  return {
    sanitized_name: String(name).replace(/[^a-zA-Z0-9 ]/g, ""),
    sanitized_image: String(image).replace(/[^a-zA-Z0-9:/.]/g, ""),
  };
};

const insertCategory = async (
  turso,
  name,
  image,
  createdAt,
  editedAt,
  userId
) => {
  const query = `
    INSERT INTO categories (name, image, created_at, edited_at, is_active)
    VALUES (?, ?, ?, ?, ?)
  `;

  const response = await turso.execute({
    sql: query,
    args: [name, image, createdAt, editedAt, true],
  });

  if (response.error) {
    console.error(
      `[ERROR] Failed to insert category: ${response.error.message}`
    );
    throw new Error("Failed to insert category");
  }

  const newCategoryId = response.lastInsertRowid.toString();

  const auditQuery = `
    INSERT INTO categories_audit (category_id, user_id, action_type, new_values)
    VALUES (?, ?, 'INSERT', ?)
  `;

  const newValues = JSON.stringify({
    name,
    image,
    createdAt,
    editedAt,
    is_active: true,
  });

  const auditResponse = await turso.execute({
    sql: auditQuery,
    args: [newCategoryId, userId, newValues],
  });

  if (auditResponse.error) {
    console.error(
      `[ERROR] Failed to insert audit record: ${auditResponse.error.message}`
    );
    throw new Error("Failed to insert audit record");
  }

  return newCategoryId;
};

const getCategoryById = async (turso, categoryId) => {
  const query = `
    SELECT id, name, image, created_at, edited_at, is_active
    FROM categories
    WHERE id = ?
  `;

  const response = await turso.execute({
    sql: query,
    args: [categoryId],
  });

  if (response.error) {
    console.error(
      `[ERROR] Failed to fetch category: ${response.error.message}`
    );
    throw new Error("Failed to fetch category");
  }

  return response.rows[0];
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

    const requestData = await request.json();
    const { name, image, user_id } = validateRequestData(requestData);

    const { sanitized_name, sanitized_image } = sanitizeData(name, image);

    const createdAt = new Date().toISOString().split("T")[0];
    const editedAt = createdAt;

    const turso = createTursoClient();

    const newCategoryId = await insertCategory(
      turso,
      sanitized_name,
      sanitized_image,
      createdAt,
      editedAt,
      user_id
    );

    console.log(
      `[SUCCESS] Category inserted successfully. ID: ${newCategoryId}`
    );

    const category = await getCategoryById(turso, newCategoryId);

    return new Response(JSON.stringify(category), {
      status: 201,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);

    let status = 500;
    if (error.message.includes("Invalid API key")) status = 403;
    if (error.message.includes("Missing required fields")) status = 400;
    if (error.message === "Method not allowed") status = 405;

    return new Response(
      JSON.stringify({
        error: error.message,
      }),
      {
        status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
};
