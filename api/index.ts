import { getApplication } from "../src/bootstrap.js";
import { createVercelExpressHandler } from "../src/http/vercel-adapter.js";

export default createVercelExpressHandler(getApplication);
