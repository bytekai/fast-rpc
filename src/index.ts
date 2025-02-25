import { z } from "zod";

type Handler<TInput, TOutput> = (input: TInput, ctx: Context) => Promise<TOutput> | TOutput;

type Context = {
  user?: {
    id: string;
    isAdmin: boolean;
  };
  timestamp?: number;
  isAdmin?: boolean;
};

type MiddlewareFunction<TContext, TNextContext = TContext> = (opts: {
  ctx: TContext;
  next: (opts: { ctx: TNextContext }) => Promise<any>;
}) => Promise<any>;

type BaseProcedure<TInput, TOutput> = {
  input: TInput;
  output?: TOutput;
  _handler: Handler<TInput, TOutput>;
  _middleware?: MiddlewareFunction<any>[];
};

type QueryProcedure<TInput, TOutput> = BaseProcedure<TInput, TOutput> & {
  _type: "query";
};

type MutationProcedure<TInput, TOutput> = BaseProcedure<TInput, TOutput> & {
  _type: "mutation";
};

type Procedure<TInput, TOutput> = QueryProcedure<TInput, TOutput> | MutationProcedure<TInput, TOutput>;

const emptyObject = {};

const notFoundResponse = Response.json({ error: "Not found" }, { status: 404 });
const errorResponse = Response.json({ error: "Unknown error" }, { status: 500 });

type inferProcedureInput<T> = T extends { input: infer TInput } ? TInput : never;
type inferProcedureOutput<T> = T extends Procedure<any, infer TOutput> ? TOutput : never;

class ProcedureBuilder<TInput = any, TOutput = any, TContext = Context> {
  private _input?: z.ZodType<TInput>;
  private _handler?: Handler<TInput, TOutput>;
  private _type: "query" | "mutation";
  private _middleware: MiddlewareFunction<any>[] = [];

  constructor(type: "query" | "mutation") {
    this._type = type;
  }

  input<T>(schema: z.ZodType<T>): ProcedureBuilder<T, TOutput> {
    const builder = new ProcedureBuilder<T, TOutput>(this._type);
    builder._input = schema;
    builder._middleware = this._middleware;
    return builder;
  }

  use<TNextContext = TContext>(
    fn: MiddlewareFunction<TContext, TNextContext>
  ): ProcedureBuilder<TInput, TOutput, TNextContext> {
    const builder = new ProcedureBuilder<TInput, TOutput, TNextContext>(this._type);
    builder._input = this._input;
    builder._middleware = [...this._middleware, fn];
    return builder;
  }

  query<T>(handler: Handler<TInput, T>): QueryProcedure<TInput, T> {
    return {
      _type: "query",
      _handler: handler,
      _middleware: this._middleware,
      input: this._input as TInput,
    };
  }

  mutation<T>(handler: Handler<TInput, T>): MutationProcedure<TInput, T> {
    return {
      _type: "mutation",
      _handler: handler,
      _middleware: this._middleware,
      input: this._input as TInput,
    };
  }
}

export type { QueryProcedure, MutationProcedure, Procedure, Context, MiddlewareFunction };

export class FastRPCBuilder {
  private context: Context;

  constructor(context: Context = {}) {
    this.context = context;
  }

  create() {
    const self = this;

    return {
      procedure: {
        input<T>(schema: z.ZodType<T>) {
          return new ProcedureBuilder<T, any>("query").input(schema);
        },
        query<TInput = void, TOutput = void>(handler: Handler<TInput, TOutput>) {
          return new ProcedureBuilder<TInput, TOutput>("query").query(handler);
        },
        mutation<TInput = void, TOutput = void>(handler: Handler<TInput, TOutput>) {
          return new ProcedureBuilder<TInput, TOutput>("mutation").mutation(handler);
        },
        use<TContext = Context, TNextContext = TContext>(fn: MiddlewareFunction<TContext, TNextContext>) {
          return new ProcedureBuilder<any, any, TContext>("query").use(fn);
        },
      },
      router: <T extends Record<string, Procedure<any, any>>>(procedures: T): FastRPC & { procedures: T } => {
        const rpc = new FastRPC(self.context);
        for (const [name, procedure] of Object.entries(procedures)) {
          rpc.procedure(name, procedure._handler, procedure._middleware || [], procedure.input as z.ZodType<any>);
        }
        return Object.assign(rpc, { procedures });
      },
    };
  }
}

export const initFastRPC = new FastRPCBuilder();

export class FastRPC {
  private routes: Record<
    string,
    { handler: Handler<any, any>; middleware?: MiddlewareFunction<any>[]; input?: z.ZodType<any> }
  > = {};
  private ctx: Context;

  constructor(context: Context = {}) {
    this.ctx = context;
  }

  procedure<TInput, TOutput>(
    name: string,
    handler: Handler<TInput, TOutput>,
    middleware: MiddlewareFunction<any>[] = [],
    input?: z.ZodType<TInput>
  ): void {
    this.routes[name] = { handler, middleware, input };
  }

  async handle(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const name = url.pathname.split("/").pop() || "";

      const route = this.routes[name];
      if (!route) return notFoundResponse;

      let input = emptyObject;
      if (req.method === "POST") {
        try {
          input = (await req.json()) as any;
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
      }

      if (route.input) {
        const result = route.input.safeParse(input);
        if (!result.success) {
          return Response.json({ error: result.error.errors }, { status: 400 });
        }
        input = result.data;
      }

      let ctx = { ...this.ctx };
      let nextCalled = false;

      if (route.middleware?.length) {
        for (const middleware of route.middleware) {
          const result = await middleware({
            ctx,
            next: async (opts) => {
              ctx = opts.ctx;
              nextCalled = true;
            },
          });

          if (result !== undefined && result instanceof Response) {
            return result;
          }

          if (!nextCalled) {
            break;
          }
          nextCalled = false;
        }
      }

      const result = await route.handler(input, ctx);
      return Response.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return Response.json({ error: error.errors }, { status: 400 });
      }
      console.error(error);
      return errorResponse;
    }
  }
}

export function createClient<T extends FastRPC & { procedures: Record<string, Procedure<any, any>> }>(
  baseUrl: string
): {
  [K in keyof T["procedures"]]: T["procedures"][K]["_type"] extends "query"
    ? {
        query: [inferProcedureInput<T["procedures"][K]>] extends [void]
          ? () => Promise<inferProcedureOutput<T["procedures"][K]>>
          : (input: inferProcedureInput<T["procedures"][K]>) => Promise<inferProcedureOutput<T["procedures"][K]>>;
      }
    : {
        mutation: [inferProcedureInput<T["procedures"][K]>] extends [void]
          ? () => Promise<inferProcedureOutput<T["procedures"][K]>>
          : (input: inferProcedureInput<T["procedures"][K]>) => Promise<inferProcedureOutput<T["procedures"][K]>>;
      };
} {
  return new Proxy({} as any, {
    get(target, name) {
      if (typeof name !== "string") return undefined;

      return {
        query: async (input?: any) => {
          const response = await fetch(`${baseUrl}/${name}`, {
            method: "GET",
          });

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          return response.json();
        },
        mutation: async (input?: any) => {
          const response = await fetch(`${baseUrl}/${name}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(input ?? {}),
          });
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          return response.json();
        },
      };
    },
  });
}
