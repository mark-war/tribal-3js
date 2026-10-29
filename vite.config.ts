import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Prefer process.cwd() over "."
  const env = loadEnv(mode, process.cwd(), "");

  const groqKey = env.GROQ_API_KEY ?? "";

  // Quick visibility while debugging – remove later
  if (!groqKey) {
    console.warn("[vite] GROQ_API_KEY is empty – proxy will send Bearer ");
  } else {
    console.log("[vite] GROQ_API_KEY loaded (length:", groqKey.length, ")");
  }

  const groq = {
    "/api/groq": {
      target: "https://api.groq.com",
      changeOrigin: true,
      secure: true,
      rewrite: (path: string) => path.replace(/^\/api\/groq/, "/openai/v1"),
      configure: (proxy: any) => {
        proxy.on("proxyReq", (proxyReq: any) => {
          proxyReq.setHeader("Authorization", `Bearer ${groqKey}`);
        });
      },
    },
  };

  return {
    plugins: [react()],
    server: { proxy: groq },
    preview: { proxy: groq },
  };
});
