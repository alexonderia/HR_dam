import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { ZodError } from "zod";
import multer from "multer";
import { router } from "./routes.js";
import { HttpError } from "./errors.js";
import { MissingImportError, isInfrastructureError } from "@hr/data-access";
import { moscowJsonReplacer, moscowTimestamp } from "@hr/contracts";

export const app = express();
app.disable("x-powered-by");
app.set("json replacer", moscowJsonReplacer);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'self'"],
        frameSrc: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
  }),
);
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use(
  "/api/candidates",
  rateLimit({
    windowMs: 60000,
    limit: 20,
    message: { error: "Слишком много загрузок. Подождите минуту." },
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use("/api", router);
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Метод API не найден." }),
);
app.use((_req, res) => res.status(404).json({ error: "Маршрут API не найден." }));
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof ZodError) {
      res
        .status(422)
        .json({
          error: "Проверьте заполнение полей.",
          fields: error.flatten().fieldErrors,
        });
      return;
    }
    if (error instanceof MissingImportError) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (isInfrastructureError(error)) {
      res.status(503).json({ error: "Обработка временно недоступна. Повторите запрос после восстановления сервисов." });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof multer.MulterError) {
      res
        .status(422)
        .json({
          error:
            "Файл слишком большой или неверное число вложений. Максимум: 50 МБ.",
        });
      return;
    }
    if ((error as { code?: string }).code === "23503") {
      res
        .status(422)
        .json({ error: "Связанная запись не найдена. Обновите страницу." });
      return;
    }
    if ((error as { code?: string }).code === "23505") {
      res.status(409).json({ error: "Такая запись уже существует." });
      return;
    }
    console.error(
      moscowTimestamp(),
      "Request failed",
      error,
    );
    res
      .status(500)
      .json({
        error: "Не удалось выполнить запрос. Проверьте доступность сервисов.",
      });
  },
);
