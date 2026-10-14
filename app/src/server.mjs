import { createServer } from "node:http";
import { greeting } from "./greeting.mjs";

createServer((_, response) => response.end(greeting("world"))).listen(process.env.PORT ?? 3000);
