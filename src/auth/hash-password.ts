import "dotenv/config";
import { createPasswordScrypt } from "./admin-auth.js";

const password = process.env.EDUSAFETY_ADMIN_PASSWORD_INPUT;
if (!password || password.length < 12) {
  throw new Error("EDUSAFETY_ADMIN_PASSWORD_INPUT must contain at least 12 characters");
}

process.stdout.write(`${await createPasswordScrypt(password)}\n`);
