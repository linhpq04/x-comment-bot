import { db } from "../db.js";

const LEVELS = { info: 0, warn: 1, error: 2 };

export const logger = {
  info(module: string, message: string) {
    console.log(`[${ts()}] [INFO] [${module}] ${message}`);
    void save("info", module, message);
  },
  warn(module: string, message: string) {
    console.warn(`[${ts()}] [WARN] [${module}] ${message}`);
    void save("warn", module, message);
  },
  error(module: string, message: string) {
    console.error(`[${ts()}] [ERROR] [${module}] ${message}`);
    void save("error", module, message);
  },
};

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function save(level: string, module: string, message: string) {
  try {
    await db.log.create({ data: { level, module, message } });
    // Giữ tối đa 2000 log gần nhất
    const count = await db.log.count();
    if (count > 2000) {
      const old = await db.log.findMany({
        orderBy: { createdAt: "asc" },
        take: count - 2000,
        select: { id: true },
      });
      await db.log.deleteMany({ where: { id: { in: old.map((l) => l.id) } } });
    }
  } catch {
    // ignore DB errors in logger
  }
}
