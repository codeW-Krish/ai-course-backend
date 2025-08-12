import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET;
const refreshSecret = process.env.REFRESH_TOKEN_SECRET;
const accessExpiresIn = process.env.ACCESS_TOKEN_EXPIRES_IN || '15m';
const refreshExpiresIn = process.env.REFRESH_TOKEN_EXPIRES_IN || '7d';

export const signAcessToken = (payload) => {
    return jwt.sign(payload, accessTokenSecret, {expiresIn: accessExpiresIn});
}

export const signRefreshToken = (payload) => {
    return jwt.sign(payload, refreshSecret, {expiresIn: refreshExpiresIn});
}

export const verifyAccessToken = (token) => {
    return jwt.verify(token, accessTokenSecret);
}

export const verifyRegreshToken = (token) => {
    return jwt.verify(token, refreshSecret)
}