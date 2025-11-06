import {z} from "zod";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import User from "../models/User.js";
import RefreshTokenModel from "../models/RefreshToken.js";
import {hashPassword, verifyPassword} from "../utils/hash.js";
import {signAccessToken, signRefreshToken, computeRefreshTokenExpiryDate, verifyRefreshToken } from "../utils/jwt.js";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get path to the JSON file
const domainsJsonPath = path.resolve(__dirname, "../node_modules/disposable-email-domains/index.json");

// Read and parse the JSON file
const domains = JSON.parse(await readFile(domainsJsonPath, "utf-8"));
const disposableDomainSet = new Set(domains);

// zod schemas for validations
const registerSchema = z.object({
    email: z.email({message: "Invalid Email Address"}).refine(email => {
        const domain = email.split("@")[1].toLowerCase();
        return domain && !disposableDomainSet.has(domain);
    },{
        message: "Disposable email addresses are not allowed"
    }),
    password: z.string().min(8, {message: "Password must be at least 8 characters long"}),
    name: z.string().min(1,{message:"Name is Required"}),
})

const loginSchema = z.object({
    email: z.email({error:"Invalid Email Address"}),
    password: z.string().min(8, {error: "Password must be at least 8 characters long"}),
})


// use in /api/auth/register
export const register = async (req, res) => {
    try {
        const result = registerSchema.safeParse(req.body);
        if(!result.success){
            return res.status(400).json({error: "Validation Failed", fields: result.error.flatten()});
        } 
        const payload = result.data;

        // Checking if a user already exists with the given email
        const userExists = await User.findByEmail(payload.email);
        if(userExists) return res.status(409).json({error: "User Already Exists With This Email"});

        // hashing and making user (inserting user to DB)
        const pwdHash = await hashPassword(payload.password);
        const user = await User.create({
            email: payload.email, 
            passwordHash: pwdHash, 
            username: payload.name,
            role: 'user' // default role
        });

        // creating tokens - now async
        const accessToken = await signAccessToken({subject: user.id});
        const refreshToken = await signRefreshToken({subject: user.id});

        const expireAt = computeRefreshTokenExpiryDate();
        await RefreshTokenModel.create({userId: user.id, token: refreshToken, expiresAt:expireAt});

        res.status(201).json({
            message: "User Created", 
            user: {
                id: user.id, 
                email: user.email, 
                username: user.username,
                role: user.role
            }, 
            accessToken, 
            refreshToken
        })

    } catch (err) {
         console.error(err);
         res.status(400).json({ error: err.message });
    }
}


export const login = async (req, res) => {
    try {
        const result = loginSchema.safeParse(req.body);
        if(!result.success){
            return res.status(400).json({error: "Validation Failed", fields: result.error.flatten()});
        }

        const payload = result.data;
        const user = await User.findByEmail(payload.email);

        if (!user) return res.status(401).json({error: "Invalid credentials"});

        const isPassValid = await verifyPassword(payload.password, user.password_hash)
        if(!isPassValid) return res.status(401).json({error: "Invalid credentials"});

        // Create tokens with role - now async
        const accessToken = await signAccessToken({subject: user.id});
        const refreshToken = await signRefreshToken({subject: user.id});

        const expireAt = computeRefreshTokenExpiryDate();
        await RefreshTokenModel.create({userId: user.id, token: refreshToken, expiresAt: expireAt});

        res.status(200).json({
            message: "Login Successfully", 
            user: {
                id: user.id, 
                email: user.email, 
                username: user.username,
                role: user.role
            }, 
            accessToken, 
            refreshToken
        });

    } catch (err) {
        console.error(err);
        res.status(400).json({error: err.message});
    }
}

// Update refresh to include role in new tokens
export const refresh = async(req, res) => {
    try {
        const token = req.body?.refreshToken || req.headers['x-refresh-token'];

        if(!token) return res.status(401).json({error: "No refresh token provided"});

        const isValidToken = await RefreshTokenModel.findByToken(token);
        if(!isValidToken) return res.status(401).json({error: "Invalid Refresh Token"});

        try {
            verifyRefreshToken(token);
        } catch (error) {
            await RefreshTokenModel.revoke(token);
            return res.status(401).json({ error: 'Refresh token invalid or expired' });
        }

        const payload = {sub: isValidToken.user_id};
        
        // Create new tokens with role - now async
        const newAccessToken = await signAccessToken(payload);
        const newRefreshToken = await signRefreshToken(payload);
        const expireAt = computeRefreshTokenExpiryDate();

        await RefreshTokenModel.revoke(token);
        await RefreshTokenModel.create({userId: isValidToken.user_id, token: newRefreshToken, expiresAt:expireAt});

        res.status(201).json({message: "New RefreshToken assigned successfully", accessToken: newAccessToken, refreshToken: newRefreshToken});
    } catch (err) {
        console.error(err);
        return res.status(401).json({error: err.message})
    }
}

export const logout = async(req, res) => {
    try {
        const token = req.body?.refreshToken || req.headers['x-refresh-token'];
        if (!token) {
            return res.status(400).json({ error: "Refresh token required for logout" });
        }

        const tokenRecord = await RefreshTokenModel.findByToken(token);
        if(!tokenRecord){
            return res.status(400).json({error: "Invalid or already revoked token"});
        }

        await RefreshTokenModel.revoke(token);
        return res.status(200).json({ message: "Logged out successfully" });

    } catch (err) {
         console.error("Logout error:", err);
         return res.status(500).json({ error: "Something went wrong during logout" });
    }
}