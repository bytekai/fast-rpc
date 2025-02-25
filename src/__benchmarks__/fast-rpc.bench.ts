import { Bench, nToMs } from "tinybench";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { initFastRPC } from "../index";
import { Hono } from "hono";
import { z } from "zod"; // For input validation

const FAST_RPC_PORT = 4002;
const BUN_PORT = 4001;
const TRPC_PORT = 4003;
const HONO_PORT = 4004;

const bench = new Bench({
  name: "API Frameworks Benchmark",
  now: () => nToMs(Bun.nanoseconds()),
  setup: (_task, mode) => {
    // Run the garbage collector before warmup at each cycle
    if (mode === "warmup") {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      Bun.gc(true);
    }
  },
  time: 100,
});

// Sample data
const users = Array.from({ length: 100 }, (_, i) => ({
  id: i + 1,
  name: `User ${i + 1}`,
  email: `user${i + 1}@example.com`,
  createdAt: new Date().toISOString(),
}));

const posts = Array.from({ length: 500 }, (_, i) => ({
  id: i + 1,
  title: `Post ${i + 1}`,
  content: `This is the content for post ${i + 1}. It contains some text to make it more realistic.`,
  authorId: Math.floor(Math.random() * 100) + 1,
  createdAt: new Date().toISOString(),
  tags: Array.from({ length: Math.floor(Math.random() * 5) + 1 }, (_, j) => `tag-${j + 1}`),
}));

// Input validation schemas
const createUserSchema = z.object({
  name: z.string().min(3).max(50),
  email: z.string().email(),
});

const updatePostSchema = z.object({
  id: z.number().positive(),
  title: z.string().min(3).max(100).optional(),
  content: z.string().min(10).optional(),
  tags: z.array(z.string()).optional(),
});

const searchParamsSchema = z.object({
  query: z.string(),
  limit: z.number().positive().optional(),
  offset: z.number().optional(),
});

// Helper functions
function getPaginatedUsers(limit = 10, offset = 0) {
  return {
    data: users.slice(offset, offset + limit),
    total: users.length,
    limit,
    offset,
  };
}

function getUserPosts(userId) {
  return posts.filter((post) => post.authorId === userId);
}

function searchPosts(query, limit = 10, offset = 0) {
  const results = posts.filter((post) => post.title.includes(query) || post.content.includes(query));
  return {
    data: results.slice(offset, offset + limit),
    total: results.length,
    limit,
    offset,
  };
}

// --------------------------------------
// FastRPC setup
// --------------------------------------
const t = initFastRPC.create();

const fastRPCRouter = t.router({
  // Simple status check
  status: t.procedure.query(() => ({ status: "ok" })),

  // Fetch paginated users
  getUsers: t.procedure
    .input(z.object({ limit: z.number().optional(), offset: z.number().optional() }))
    .query((input) => getPaginatedUsers(input.limit, input.offset)),

  // Get user by ID with all their posts
  getUserWithPosts: t.procedure.input(z.object({ userId: z.number() })).query((input) => {
    const user = users.find((u) => u.id === input.userId);
    if (!user) throw new Error("User not found");
    return {
      ...user,
      posts: getUserPosts(input.userId),
    };
  }),

  // Create new user with validation
  createUser: t.procedure.input(createUserSchema).mutation((input) => {
    const newUser = {
      id: users.length + 1,
      ...input,
      createdAt: new Date().toISOString(),
    };
    // In a real app, we'd add to the database
    return newUser;
  }),

  // Update post with validation
  updatePost: t.procedure.input(updatePostSchema).mutation((input) => {
    const postIndex = posts.findIndex((p) => p.id === input.id);
    if (postIndex === -1) throw new Error("Post not found");
    // In a real app, we'd update the database
    return { success: true, id: input.id };
  }),

  // Search posts with pagination
  searchPosts: t.procedure
    .input(searchParamsSchema)
    .query((input) => searchPosts(input.query, input.limit, input.offset)),
});

// --------------------------------------
// Bun router setup
// --------------------------------------
const bunRouter = {
  "/status": () => Response.json({ status: "ok" }),

  "/users": (req) => {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "10");
    const offset = parseInt(url.searchParams.get("offset") || "0");
    return Response.json(getPaginatedUsers(limit, offset));
  },

  "/users/:id/with-posts": (req, params) => {
    const userId = parseInt(params.id);
    const user = users.find((u) => u.id === userId);
    if (!user) return new Response("User not found", { status: 404 });
    return Response.json({
      ...user,
      posts: getUserPosts(userId),
    });
  },

  "/users/create": async (req) => {
    try {
      const body = await req.json();
      const validatedInput = createUserSchema.parse(body);
      const newUser = {
        id: users.length + 1,
        ...validatedInput,
        createdAt: new Date().toISOString(),
      };
      return Response.json(newUser);
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  },

  "/posts/update": async (req) => {
    try {
      const body = await req.json();
      const validatedInput = updatePostSchema.parse(body);
      const postIndex = posts.findIndex((p) => p.id === validatedInput.id);
      if (postIndex === -1) throw new Error("Post not found");
      return Response.json({ success: true, id: validatedInput.id });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  },

  "/posts/search": (req) => {
    const url = new URL(req.url);
    const query = url.searchParams.get("query") || "";
    const limit = parseInt(url.searchParams.get("limit") || "10");
    const offset = parseInt(url.searchParams.get("offset") || "0");

    try {
      searchParamsSchema.parse({ query, limit, offset });
      return Response.json(searchPosts(query, limit, offset));
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};

// --------------------------------------
// tRPC setup
// --------------------------------------
const trpc = initTRPC.create();

const trpcRouter = trpc.router({
  status: trpc.procedure.query(() => ({ status: "ok" })),

  getUsers: trpc.procedure
    .input(z.object({ limit: z.number().optional(), offset: z.number().optional() }))
    .query(({ input }) => getPaginatedUsers(input.limit, input.offset)),

  getUserWithPosts: trpc.procedure.input(z.object({ userId: z.number() })).query(({ input }) => {
    const user = users.find((u) => u.id === input.userId);
    if (!user) throw new Error("User not found");
    return {
      ...user,
      posts: getUserPosts(input.userId),
    };
  }),

  createUser: trpc.procedure.input(createUserSchema).mutation(({ input }) => {
    const newUser = {
      id: users.length + 1,
      ...input,
      createdAt: new Date().toISOString(),
    };
    return newUser;
  }),

  updatePost: trpc.procedure.input(updatePostSchema).mutation(({ input }) => {
    const postIndex = posts.findIndex((p) => p.id === input.id);
    if (postIndex === -1) throw new Error("Post not found");
    return { success: true, id: input.id };
  }),

  searchPosts: trpc.procedure
    .input(searchParamsSchema)
    .query(({ input }) => searchPosts(input.query, input.limit, input.offset)),
});

// --------------------------------------
// Hono setup
// --------------------------------------
const hono = new Hono();

hono.get("/status", (c) => c.json({ status: "ok" }));

hono.get("/users", (c) => {
  const limit = parseInt(c.req.query("limit") || "10");
  const offset = parseInt(c.req.query("offset") || "0");
  return c.json(getPaginatedUsers(limit, offset));
});

hono.get("/users/:id/with-posts", (c) => {
  const userId = parseInt(c.req.param("id"));
  const user = users.find((u) => u.id === userId);
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json({
    ...user,
    posts: getUserPosts(userId),
  });
});

hono.post("/users/create", async (c) => {
  try {
    const body = await c.req.json();
    const validatedInput = createUserSchema.parse(body);
    const newUser = {
      id: users.length + 1,
      ...validatedInput,
      createdAt: new Date().toISOString(),
    };
    return c.json(newUser);
  } catch (error) {
    return c.json({ error: error.message }, 400);
  }
});

hono.post("/posts/update", async (c) => {
  try {
    const body = await c.req.json();
    const validatedInput = updatePostSchema.parse(body);
    const postIndex = posts.findIndex((p) => p.id === validatedInput.id);
    if (postIndex === -1) return c.json({ error: "Post not found" }, 404);
    return c.json({ success: true, id: validatedInput.id });
  } catch (error) {
    return c.json({ error: error.message }, 400);
  }
});

hono.get("/posts/search", (c) => {
  const query = c.req.query("query") || "";
  const limit = parseInt(c.req.query("limit") || "10");
  const offset = parseInt(c.req.query("offset") || "0");

  try {
    searchParamsSchema.parse({ query, limit, offset });
    return c.json(searchPosts(query, limit, offset));
  } catch (error) {
    return c.json({ error: error.message }, 400);
  }
});

// --------------------------------------
// Start servers
// --------------------------------------
const bunServer = Bun.serve({
  port: BUN_PORT,
  routes: bunRouter,
});

const fastRPCServer = Bun.serve({
  port: FAST_RPC_PORT,
  fetch(req) {
    return fastRPCRouter.handle(req);
  },
});

const trpcServer = Bun.serve({
  port: TRPC_PORT,
  async fetch(req) {
    return fetchRequestHandler({
      req,
      router: trpcRouter,
      endpoint: "/",
      createContext() {
        return {};
      },
    });
  },
});

const honoServer = Bun.serve({
  port: HONO_PORT,
  fetch: hono.fetch,
});

// --------------------------------------
// Add benchmarks
// --------------------------------------
// Simple status check
bench.add("Simple - FastRPC", async () => {
  await fetch(`http://localhost:${FAST_RPC_PORT}/status`);
});

bench.add("Simple - Bun Router", async () => {
  await fetch(`http://localhost:${BUN_PORT}/status`);
});

bench.add("Simple - tRPC", async () => {
  await fetch(`http://localhost:${TRPC_PORT}/status`);
});

bench.add("Simple - Hono", async () => {
  await fetch(`http://localhost:${HONO_PORT}/status`);
});

// Get paginated users
bench.add("Pagination - FastRPC", async () => {
  const response = await fetch(`http://localhost:${FAST_RPC_PORT}/getUsers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      params: { limit: 20, offset: 0 },
    }),
  });
  await response.json();
});

bench.add("Pagination - Bun Router", async () => {
  const response = await fetch(`http://localhost:${BUN_PORT}/users?limit=20&offset=0`);
  await response.json();
});

bench.add("Pagination - tRPC", async () => {
  const response = await fetch(`http://localhost:${TRPC_PORT}/getUsers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      params: { limit: 20, offset: 0 },
    }),
  });
  await response.json();
});

bench.add("Pagination - Hono", async () => {
  const response = await fetch(`http://localhost:${HONO_PORT}/users?limit=20&offset=0`);
  await response.json();
});

// Get user with posts (nested data)
bench.add("Nested Data - FastRPC", async () => {
  const userId = Math.floor(Math.random() * 100) + 1;
  const response = await fetch(`http://localhost:${FAST_RPC_PORT}/getUserWithPosts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      params: { userId },
    }),
  });
  await response.json();
});

bench.add("Nested Data - Bun Router", async () => {
  const userId = Math.floor(Math.random() * 100) + 1;
  const response = await fetch(`http://localhost:${BUN_PORT}/users/${userId}/with-posts`);
  await response.json();
});

bench.add("Nested Data - tRPC", async () => {
  const userId = Math.floor(Math.random() * 100) + 1;
  const response = await fetch(`http://localhost:${TRPC_PORT}/getUserWithPosts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      params: { userId },
    }),
  });
  await response.json();
});

bench.add("Nested Data - Hono", async () => {
  const userId = Math.floor(Math.random() * 100) + 1;
  const response = await fetch(`http://localhost:${HONO_PORT}/users/${userId}/with-posts`);
  await response.json();
});

// Create user (POST with validation)
bench.add("Validation - FastRPC", async () => {
  const rnd = Math.floor(Math.random() * 10000);
  const response = await fetch(`http://localhost:${FAST_RPC_PORT}/createUser`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      params: {
        name: `Test User ${rnd}`,
        email: `test${rnd}@example.com`,
      },
    }),
  });
  await response.json();
});

bench.add("Validation - Bun Router", async () => {
  const rnd = Math.floor(Math.random() * 10000);
  const response = await fetch(`http://localhost:${BUN_PORT}/users/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Test User ${rnd}`,
      email: `test${rnd}@example.com`,
    }),
  });
  await response.json();
});

bench.add("Validation - tRPC", async () => {
  const rnd = Math.floor(Math.random() * 10000);
  const response = await fetch(`http://localhost:${TRPC_PORT}/createUser`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      params: {
        name: `Test User ${rnd}`,
        email: `test${rnd}@example.com`,
      },
    }),
  });
  await response.json();
});

bench.add("Validation - Hono", async () => {
  const rnd = Math.floor(Math.random() * 10000);
  const response = await fetch(`http://localhost:${HONO_PORT}/users/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Test User ${rnd}`,
      email: `test${rnd}@example.com`,
    }),
  });
  await response.json();
});

// Search with multiple parameters
bench.add("Search Query - FastRPC", async () => {
  const response = await fetch(`http://localhost:${FAST_RPC_PORT}/searchPosts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      params: {
        query: "content",
        limit: 15,
        offset: 5,
      },
    }),
  });
  await response.json();
});

bench.add("Search Query - Bun Router", async () => {
  const response = await fetch(`http://localhost:${BUN_PORT}/posts/search?query=content&limit=15&offset=5`);
  await response.json();
});

bench.add("Search Query - tRPC", async () => {
  const response = await fetch(`http://localhost:${TRPC_PORT}/searchPosts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      params: {
        query: "content",
        limit: 15,
        offset: 5,
      },
    }),
  });
  await response.json();
});

bench.add("Search Query - Hono", async () => {
  const response = await fetch(`http://localhost:${HONO_PORT}/posts/search?query=content&limit=15&offset=5`);
  await response.json();
});

// Run benchmark
await bench.run();

console.log(bench.name);
console.table(bench.table());

// Clean up servers
bunServer.stop();
fastRPCServer.stop();
trpcServer.stop();
honoServer.stop();

process.exit(0);
