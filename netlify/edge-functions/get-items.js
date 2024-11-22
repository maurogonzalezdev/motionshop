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

const validateItemId = (itemId) => {
  if (itemId && isNaN(Number(itemId))) {
    throw new Error("Invalid item ID");
  }
};

const getItemWithCategories = async (turso, itemId) => {
  const itemResponse = await turso.execute({
    sql: `
      SELECT 
        i.*,
        GROUP_CONCAT(ic.category_id) as category_ids,
        GROUP_CONCAT(c.name) as category_names,
        GROUP_CONCAT(c.is_active) as category_active_states
      FROM items i
      JOIN item_categories ic ON i.id = ic.item_id
      JOIN categories c ON ic.category_id = c.id
      WHERE i.id = ? 
        AND i.is_deleted = 0
        AND c.is_deleted = 0
      GROUP BY i.id
    `,
    args: [itemId],
  });

  if (!itemResponse?.rows?.length) {
    throw new Error("Item not found");
  }

  const item = { ...itemResponse.rows[0] };
  const categoryIds = item.category_ids.split(",");
  const categoryNames = item.category_names.split(",");
  const categoryActiveStates = item.category_active_states.split(",");

  item.categories = categoryIds.map((id, index) => ({
    id: Number(id),
    name: categoryNames[index],
    is_active: categoryActiveStates[index] === "1",
  }));

  delete item.category_ids;
  delete item.category_names;
  delete item.category_active_states;

  return item;
};

const getAllItems = async (turso) => {
  const itemsResponse = await turso.execute({
    sql: `
      SELECT 
        i.*,
        GROUP_CONCAT(ic.category_id) as category_ids,
        GROUP_CONCAT(c.name) as category_names,
        GROUP_CONCAT(c.is_active) as category_active_states
      FROM items i
      JOIN item_categories ic ON i.id = ic.item_id
      JOIN categories c ON ic.category_id = c.id
      WHERE i.is_deleted = 0
        AND c.is_deleted = 0
      GROUP BY i.id
    `,
    args: [],
  });

  return itemsResponse.rows.map((row) => {
    const item = { ...row };
    const categoryIds = item.category_ids.split(",");
    const categoryNames = item.category_names.split(",");
    const categoryActiveStates = item.category_active_states.split(",");

    item.categories = categoryIds.map((id, index) => ({
      id: Number(id),
      name: categoryNames[index],
      is_active: categoryActiveStates[index] === "1",
    }));

    delete item.category_ids;
    delete item.category_names;
    delete item.category_active_states;

    return item;
  });
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

    const itemId = url.searchParams.get("id");
    validateItemId(itemId);

    const turso = createTursoClient();
    let items;

    console.log(
      "[INFO] Processing get request:",
      itemId ? `for item ID: ${itemId}` : "for all items"
    );

    if (itemId) {
      items = await getItemWithCategories(turso, itemId);
    } else {
      items = await getAllItems(turso);
    }

    console.log("[INFO] Get successful. Items retrieved.");

    return new Response(JSON.stringify(items), {
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
    if (error.message === "Item not found") status = 404;
    if (error.message.includes("Invalid parameter")) status = 400;
    if (error.message.includes("Invalid item ID")) status = 400;

    console.log("[INFO] Get failed.");

    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
};
