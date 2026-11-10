import * as dotenv from "dotenv"; dotenv.config();
import jwt from "jsonwebtoken";
const secret = process.env.JWT_SECRET || require("../src/utils/jwt.utils").JWT_SECRET;
console.log(jwt.sign({ id: "test", name: "Prueba local", role: process.argv[2] }, secret, { expiresIn: "10m" }));
