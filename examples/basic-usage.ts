import { initFastRPC, createClient } from "../src";
import { z } from "zod";

// Define your types with Zod
const UserInput = z.object({
  name: z.string(),
  email: z.string().email(),
});

type User = {
  id: string;
  name: string;
  email: string;
};

// Create your RPC router
const t = initFastRPC.create();

const appRouter = t.router({
  getUser: t.procedure.input(z.object({ id: z.string() })).query(async ({ id }: { id: string }) => {
    return { id, name: "John", email: "john@example.com" };
  }),

  createUser: t.procedure.input(UserInput).mutation(async (input: z.infer<typeof UserInput>): Promise<User> => {
    return {
      id: "generated-id",
      ...input,
    };
  }),

  listUsers: t.procedure.query(async () => {
    return [
      { id: "1", name: "John", email: "john@example.com" },
      { id: "2", name: "Jane", email: "jane@example.com" },
    ];
  }),
});

// Example client usage
const client = createClient<typeof appRouter>("http://localhost:3000");

async function example() {
  // Query existing user
  const user = await client.getUser.query({ id: "1" });
  console.log(user.name); // Type-safe access

  // Create new user
  const newUser = await client.createUser.mutation({
    name: "Alice",
    email: "alice@example.com",
  });

  // List all users
  const users = await client.listUsers.query();
}
