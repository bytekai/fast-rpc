import { describe, it, expect, beforeEach, vi } from "vitest";
import { initFastRPC, createClient, FastRPC, QueryProcedure, Context } from "../index";
import { z } from "zod";

// Mock fetch for client tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Add type definition at the top
type MiddlewareContext = Context & { timestamp?: number };

describe("FastRPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Procedure Builder", () => {
    it("should create query procedures with proper types", () => {
      const t = initFastRPC.create();
      const procedure = t.procedure.input(z.object({ id: z.string() })).query(({ id }, ctx) => ({ id, value: "test" }));

      expect(procedure).toBeDefined();
      expect(typeof procedure._handler).toBe("function");
    });

    it("should create mutation procedures with proper types", () => {
      const t = initFastRPC.create();
      const procedure = t.procedure
        .input(z.object({ data: z.string() }))
        .mutation(({ data }, ctx) => ({ success: true, data }));

      expect(procedure).toBeDefined();
      expect(typeof procedure._handler).toBe("function");
    });

    it("should handle procedures without input schema", () => {
      const t = initFastRPC.create();
      const procedure = t.procedure.query(() => ({ status: "ok" }));

      expect(procedure).toBeDefined();
      expect(typeof procedure._handler).toBe("function");
    });
  });

  describe("Router", () => {
    let appRouter: FastRPC & { procedures: any };

    beforeEach(() => {
      const t = initFastRPC.create();

      appRouter = t.router({
        getUser: t.procedure.input(z.object({ id: z.string() })).query(({ id }) => ({ id, name: "Test User" })),

        createUser: t.procedure.input(z.object({ name: z.string() })).mutation(({ name }) => ({ id: "1", name })),

        status: t.procedure.query(() => ({ status: "ok" })),
      });
    });

    it("should register all procedures", () => {
      expect(appRouter).toBeDefined();
      expect(appRouter.handle).toBeDefined();
    });

    it("should handle GET requests", async () => {
      const req = new Request("http://localhost/status", {
        method: "GET",
      });

      const response = await appRouter.handle(req);
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result).toEqual({ status: "ok" });
    });

    it("should handle POST requests with input validation", async () => {
      const req = new Request("http://localhost/createUser", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Test User" }),
      });

      const response = await appRouter.handle(req);
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result).toEqual({ id: "1", name: "Test User" });
    });

    it("should return 404 for unknown procedures", async () => {
      const req = new Request("http://localhost/unknown", {
        method: "GET",
      });

      const response = await appRouter.handle(req);
      expect(response.status).toBe(404);
    });

    it("should handle input validation errors", async () => {
      const t = initFastRPC.create();

      const appRouter = t.router({
        createUser: t.procedure.input(z.object({ name: z.string() })).mutation(async (input) => input),
      });

      const req = new Request("http://localhost/createUser", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ invalid: "input" }),
      });

      const response = await appRouter.handle(req);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result).toHaveProperty("error");
    });
  });

  describe("Middleware", () => {
    it("should execute middleware chain", async () => {
      const middlewareSpy = vi.fn();
      const t = initFastRPC.create();

      type MiddlewareContext = Context & { timestamp?: number };

      const addTimestamp = async (opts: {
        ctx: MiddlewareContext;
        next: (opts: { ctx: MiddlewareContext }) => Promise<any>;
      }) => {
        middlewareSpy("timestamp");
        return opts.next({
          ctx: { ...opts.ctx, timestamp: Date.now() },
        });
      };

      const isAdmin = async (opts: {
        ctx: MiddlewareContext;
        next: (opts: { ctx: MiddlewareContext }) => Promise<any>;
      }) => {
        middlewareSpy("admin");
        if (!opts.ctx.isAdmin) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        return opts.next({
          ctx: { ...opts.ctx, isAdmin: true },
        });
      };

      const appRouter = t.router({
        adminOnly: t.procedure
          .use(addTimestamp)
          .use(isAdmin)
          .query(() => "admin data"),
      });

      const req = new Request("http://localhost/adminOnly");
      await appRouter.handle(req);

      expect(middlewareSpy).toHaveBeenCalledTimes(2);
      expect(middlewareSpy).toHaveBeenNthCalledWith(1, "timestamp");
      expect(middlewareSpy).toHaveBeenNthCalledWith(2, "admin");
    });

    it("should handle middleware errors", async () => {
      const t = initFastRPC.create();

      const isAdmin = async (opts: {
        ctx: MiddlewareContext;
        next: (opts: { ctx: MiddlewareContext }) => Promise<any>;
      }) => {
        if (!opts.ctx.isAdmin) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        return opts.next(opts);
      };

      const appRouter = t.router({
        adminOnly: t.procedure.use(isAdmin).query(() => "admin data"),
      });

      const req = new Request("http://localhost/adminOnly");
      const response = await appRouter.handle(req);
      expect(response.status).toBe(401);
    });
  });

  describe("Client", () => {
    beforeEach(() => {
      mockFetch.mockClear();
    });

    it("should create type-safe client", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "1", data: "test" }),
      });

      const t = initFastRPC.create();
      type Router = {
        getData: QueryProcedure<{ id: string }, { id: string; data: string }>;
      };

      const appRouter = t.router({
        getData: t.procedure.input(z.object({ id: z.string() })).query(({ id }) => ({ id, data: "test" })),
      });

      const client = createClient<Router>("http://localhost");
      const result = await client.getData.query();
      expect(result.data).toBe("test");
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const t = initFastRPC.create();

      type Router = {
        test: QueryProcedure<void, { ok: boolean }>;
      };

      const appRouter = t.router({
        test: t.procedure.query((input, ctx) => ({ ok: true })),
      } as Router);

      const client = createClient<Router>("http://localhost");

      await expect(client.test.query()).rejects.toThrow("Network error");
    });
  });
});
