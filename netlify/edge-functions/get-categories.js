import { createClient } from "https://esm.sh/@libsql/client@0.6.0/web";

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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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

const validateUrlParams = (url) => {
  const allowedParams = ["id"];
  for (const param of url.searchParams.keys()) {
    if (!allowedParams.includes(param)) {
      throw new Error(`Invalid parameter: ${param}`);
    }
  }
};

const validateCategoryId = (categoryId) => {
  if (categoryId && isNaN(Number(categoryId))) {
    throw new Error("Invalid category ID");
  }
};

export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (request.method !== "GET") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    const url = new URL(request.url);
    validateUrlParams(url);

    const categoryId = url.searchParams.get("id");
    validateCategoryId(categoryId);

    const turso = createTursoClient();

    // Log de entrada con parámetros
    console.log("[INFO] Received get request with parameters:", {
      categoryId,
    });

    let response;

    if (categoryId) {
      console.log("[INFO] Fetching specific category with ID:", categoryId);
      // Obtener una categoría específica
      response = await turso.execute({
        sql: `
          SELECT id, name, image, created_at, edited_at, is_active
          FROM categories
          WHERE id = ?
        `,
        args: [categoryId],
      });

      if (!response?.rows?.length) {
        throw new Error("Category not found");
      }
    } else {
      console.log("[INFO] Fetching all categories");
      // Obtener todas las categorías
      response = await turso.execute({
        sql: `
          SELECT id, name, image, created_at, edited_at, is_active
          FROM categories
        `,
        args: [],
      });
    }

    const categories = categoryId ? response.rows[0] : response.rows;

    // Log de resultado exitoso
    console.log("[INFO] Get successful. Categories retrieved.");

    return new Response(JSON.stringify(categories), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("[ERROR] Operation failed:", error);

    let status = 500;
    if (error.message.includes("API key")) status = 403;
    if (error.message === "Method not allowed") status = 405;
    if (error.message === "Category not found") status = 404;
    if (error.message.includes("Invalid parameter")) status = 400;
    if (error.message.includes("Invalid category ID")) status = 400;

    // Log de resultado fallido
    console.log("[INFO] Get failed.");

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