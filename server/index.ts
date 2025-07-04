import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { log, serveStatic } from "./vite";
import { initializeDatabase } from "./init-db";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";

const app = express();

// Security and performance middleware for production
if (process.env.NODE_ENV === "production") {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
  }));
  app.use(compression());
  
  // Rate limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: "Too many requests from this IP, please try again later.",
  });
  app.use("/api", limiter);
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false, limit: "10mb" }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Initialize database with contest data
  try {
    await initializeDatabase();
  } catch (error) {
    log("Database initialization failed, continuing anyway");
  }

  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  const isProduction = process.env.NODE_ENV === "production" || 
                      process.env.PORT === "5000" || 
                      process.env.PORT === "8080" ||
                      !process.env.REPL_ID;
  
  if (!isProduction && app.get("env") === "development") {
    try {
      log("Development mode detected, attempting to setup Vite");
      
      // Inline vite setup to avoid external file imports
      const vite = await import("vite");
      const { nanoid } = await import("nanoid");
      const path = await import("path");
      const fs = await import("fs");
      
      const viteLogger = vite.createLogger();
      const serverOptions = {
        middlewareMode: true,
        hmr: { server },
        allowedHosts: true as const,
      };

      const viteServer = await vite.createServer({
        configFile: false,
        customLogger: {
          ...viteLogger,
          error: (msg, options) => {
            viteLogger.error(msg, options);
            process.exit(1);
          },
        },
        server: serverOptions,
        appType: "custom",
        plugins: [
          (await import("@vitejs/plugin-react")).default(),
        ],
        resolve: {
          alias: {
            "@": path.resolve(process.cwd(), "client", "src"),
            "@shared": path.resolve(process.cwd(), "shared"),
            "@assets": path.resolve(process.cwd(), "attached_assets"),
          },
        },
        root: path.resolve(process.cwd(), "client"),
        build: {
          outDir: path.resolve(process.cwd(), "dist/public"),
          emptyOutDir: true,
        },
      });

      app.use(viteServer.middlewares);
      app.use("*", async (req, res, next) => {
        const url = req.originalUrl;
        try {
          const clientTemplate = path.resolve(process.cwd(), "client", "index.html");
          let template = await fs.promises.readFile(clientTemplate, "utf-8");
          template = template.replace(
            `src="/src/main.tsx"`,
            `src="/src/main.tsx?v=${nanoid()}`
          );
          const page = await viteServer.transformIndexHtml(url, template);
          res.status(200).set({ "Content-Type": "text/html" }).end(page);
        } catch (e) {
          viteServer.ssrFixStacktrace(e as Error);
          next(e);
        }
      });
      
      log("Vite development server setup complete");
    } catch (error) {
      log("Failed to setup Vite development server, serving static files");
      console.error(error);
      serveStatic(app);
    }
  } else {
    log("Production mode detected, serving static files");
    serveStatic(app);
  }

  // ALWAYS serve the app on port 5000
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000");
  const server_instance = server.listen({
    port,
    host: "0.0.0.0",
    ...(process.platform !== "win32" && { reusePort: true }),
  }, () => {
    log(`serving on port ${port}`);
  });

  // Graceful shutdown handling
  const gracefulShutdown = (signal: string) => {
    log(`Received ${signal}, shutting down gracefully...`);
    server_instance.close(() => {
      log("HTTP server closed.");
      process.exit(0);
    });

    // Force close after 10 seconds
    setTimeout(() => {
      log("Forcing shutdown after timeout");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    log(`Uncaught Exception: ${error.message}`);
    console.error(error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason, promise) => {
    log(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    console.error(reason);
    process.exit(1);
  });
})();
