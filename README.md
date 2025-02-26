# FastRPC

FastRPC is a lightweight, flexible framework for building remote procedure call (RPC) APIs in TypeScript. It provides a structured way to define queries and mutations, apply middleware, and handle requests efficiently.

## Features
- **Type-Safe Procedures**: Uses `zod` for input validation.
- **Middleware Support**: Apply middleware functions to procedures.
- **Flexible Context Handling**: Pass user context to procedures.
- **Efficient Request Handling**: Designed for performance and scalability.

## Installation
```sh
npm install zod
```

## Usage

### Defining Procedures
```ts
import { z } from "zod";
import { initFastRPC } from "./path-to-fastrpc";

const rpc = initFastRPC.create();

const getUser = rpc.procedure.query(async (input, ctx) => {
  return { userId: ctx.user?.id, name: "John Doe" };
});

const updateUser = rpc.procedure
  .input(z.object({ name: z.string() }))
  .mutation(async (input, ctx) => {
    return { success: true, name: input.name };
  });
```

### Creating a Router
```ts
const api = rpc.router({
  getUser,
  updateUser,
});
```

### Handling Requests
```ts
addEventListener("fetch", (event) => {
  event.respondWith(api.handle(event.request));
});
```

## Middleware Example
```ts
const authMiddleware = async ({ ctx, next }) => {
  if (!ctx.user) {
    return new Response("Unauthorized", { status: 401 });
  }
  return next({ ctx });
};

const protectedProcedure = rpc.procedure.use(authMiddleware).query(async (input, ctx) => {
  return { message: "Secure data" };
});
```

## Context Example
```ts
const context = { user: { id: "123", isAdmin: true } };
const rpcWithContext = new FastRPCBuilder(context).create();
```

## Error Handling
FastRPC automatically handles errors with proper HTTP responses:
- `400` for validation errors
- `401` for unauthorized access (if implemented in middleware)
- `500` for unexpected server errors

## License
MIT

