# GridFlex TypeScript coding-agent handoff

Use the files in this order:

1. `GridFlex_V2_TypeScript_Coding_Agent_Implementation_Spec.md`
2. `gridflex_schema.sql`
3. `gridflex_seed.sql`
4. `.env.example`
5. `GridFlex_private.env` only during controlled Coolify setup

The implementation is TypeScript end to end: Next.js web, NestJS/Fastify API, standalone NestJS worker, Zod contracts, Drizzle ORM, and PostgreSQL.

The private environment file contains a live database credential. Do not upload it to GitHub, paste it into an issue, expose it in a frontend build, or share the private bundle publicly. Rotate the database password after deployment.
