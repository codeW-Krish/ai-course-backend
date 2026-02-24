import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "..", ".env") });

const BASE_URL = process.env.BASE_URL || "http://localhost:3030";
const TEST_EMAIL = `auth_contract_${Date.now()}@example.com`;
const TEST_PASSWORD = "AuthPass123!";
const TEST_USERNAME = `auth_user_${Date.now()}`;

const pretty = (value) => JSON.stringify(value, null, 2);

const req = async (method, path, body = null, headers = {}) => {
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE_URL}${path}`, options);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  return { status: response.status, data };
};

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const pickAccessToken = (payload) =>
  payload?.accessToken || payload?.access_token || payload?.token || payload?.jwt || payload?.data?.accessToken || payload?.tokens?.accessToken;

const pickRefreshToken = (payload) =>
  payload?.refreshToken || payload?.refresh_token || payload?.refresh || payload?.data?.refreshToken || payload?.tokens?.refreshToken;

async function main() {
  console.log("\n🔐 Auth Contract Test");
  console.log("────────────────────────────────────────");
  console.log(`Base URL: ${BASE_URL}`);

  const registerRes = await req("POST", "/api/auth/register", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    username: TEST_USERNAME,
  });

  assert(registerRes.status === 201, `Register failed: ${registerRes.status} ${pretty(registerRes.data)}`);
  console.log("✅ Register ok");

  const loginRes = await req("POST", "/api/auth/login", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });

  assert(loginRes.status === 200, `Login failed: ${loginRes.status} ${pretty(loginRes.data)}`);
  assert(loginRes.data?.user?.id, "Login missing user");

  const accessToken = pickAccessToken(loginRes.data);
  const refreshToken = pickRefreshToken(loginRes.data);

  assert(accessToken, "Login missing access token");
  assert(refreshToken, "Login missing refresh token");
  console.log("✅ Login contract ok (user + access + refresh)");

  const protectedRes = await req(
    "GET",
    "/api/courses/me",
    null,
    { Authorization: `Bearer ${accessToken}` }
  );

  assert(
    protectedRes.status === 200 || protectedRes.status === 404,
    `Protected route did not accept Bearer access token: ${protectedRes.status} ${pretty(protectedRes.data)}`
  );
  console.log("✅ Protected route accepts Bearer access token");

  const refreshRes = await req("POST", "/api/auth/refresh", {
    refresh_token: refreshToken,
  });

  assert(refreshRes.status === 200, `Refresh failed: ${refreshRes.status} ${pretty(refreshRes.data)}`);

  const refreshedAccessToken = pickAccessToken(refreshRes.data);
  const refreshedRefreshToken = pickRefreshToken(refreshRes.data);

  assert(refreshedAccessToken, "Refresh missing new access token");
  assert(refreshedRefreshToken, "Refresh missing refresh token");
  console.log("✅ Refresh contract ok (accepts refresh_token alias)");

  const refreshWithBearerRes = await req(
    "POST",
    "/api/auth/refresh",
    {},
    { Authorization: `Bearer ${refreshedRefreshToken}` }
  );

  assert(
    refreshWithBearerRes.status === 200,
    `Refresh with Bearer refresh token failed: ${refreshWithBearerRes.status} ${pretty(refreshWithBearerRes.data)}`
  );
  console.log("✅ Refresh accepts Bearer refresh token");

  const noTokenRes = await req("GET", "/api/courses/me");
  assert(noTokenRes.status === 401, `Expected 401 without token, got ${noTokenRes.status}`);
  assert(noTokenRes.data?.reason === "missing_token", `Expected reason missing_token, got ${pretty(noTokenRes.data)}`);
  console.log("✅ 401 reason code for missing token is explicit");

  console.log("\n📦 Runtime sample: /api/auth/login");
  console.log(pretty(loginRes.data));

  console.log("\n📦 Runtime sample: /api/auth/refresh");
  console.log(pretty(refreshRes.data));

  console.log("\n🎉 Auth contract checks passed.");
}

main().catch((error) => {
  console.error("\n❌ Auth contract test failed:", error.message);
  process.exit(1);
});
