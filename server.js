
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const app = Fastify({
  logger: true,
  bodyLimit: 22 * 1024 * 1024
});

await app.register(multipart, {
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 1,
    fields: 2
  }
});

const DATA = path.resolve("./data");
const deployments = new Map();

await fs.mkdir(path.join(DATA, "uploads"), { recursive: true });

function run(command, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", b => stdout += b.toString());
    child.stderr.on("data", b => stderr += b.toString());

    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.slice(-1500) || `Exit code ${code}`));
    });
  });
}

app.get("/api/health", async () => ({ ok: true }));

app.get("/api/deployments", async () =>
  [...deployments.values()].map(d => ({
    id: d.id,
    name: d.name,
    status: d.status,
    url: d.url,
    message: d.message
  }))
);

app.post("/api/deployments", async (request, reply) => {
  let projectDir;

  try {
    const file = await request.file();

    if (!file) {
      return reply.code(400).send({
        error: "Choose a ZIP file to upload."
      });
    }

    if (!file.filename.toLowerCase().endsWith(".zip")) {
      file.file.resume();
      return reply.code(400).send({
        error: "Only ZIP files are supported."
      });
    }

    const id = randomUUID().slice(0, 12);
    const name = path.basename(file.filename, ".zip")
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .slice(0, 40) || "project";

    const archive = path.join(DATA, "uploads", `${id}.zip`);
    projectDir = path.join(DATA, "uploads", id);

    await pipeline(file.file, createWriteStream(archive));

    if (file.file.truncated) {
      await fs.rm(archive, { force: true });
      return reply.code(413).send({
        error: "Upload exceeds the 20 MB limit."
      });
    }

    await fs.mkdir(projectDir, { recursive: true });

    // Extract in a disposable container, not inside the API process.
    // Reject unsafe paths, symlinks, and oversized expanded archives.
    const extractionScript = `
import zipfile, stat
z = zipfile.ZipFile('/input/project.zip')
items = z.infolist()
if len(items) > 2000:
    raise Exception('Too many files')
total = sum(i.file_size for i in items)
if total > 100 * 1024 * 1024:
    raise Exception('Expanded archive exceeds 100 MB')
for i in items:
    p = i.filename.replace('\\\\\\\\', '/')
    if p.startswith('/') or '..' in p.split('/'):
        raise Exception('Unsafe archive path')
    if stat.S_ISLNK(i.external_attr >> 16):
        raise Exception('Symlinks are not allowed')
z.extractall('/out')
`;

    await run("docker", [
      "run", "--rm",
      "--network", "none",
      "--memory", "128m",
      "--cpus", "0.5",
      "--pids-limit", "64",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "-v", `${archive}:/input/project.zip:ro`,
      "-v", `${projectDir}:/out`,
      "python:3.12-alpine",
      "python", "-c", extractionScript
    ]);

    await fs.rm(archive, { force: true });

    // Handle ZIPs that contain one enclosing folder.
    let entries = await fs.readdir(projectDir, {
      withFileTypes: true
    });

    if (entries.length === 1 && entries[0].isDirectory()) {
      const nested = path.join(projectDir, entries[0].name);
      const children = await fs.readdir(nested);

      for (const child of children) {
        await fs.rename(
          path.join(nested, child),
          path.join(projectDir, child)
        );
      }

      await fs.rm(nested, { recursive: true, force: true });
    }

    const pkg = JSON.parse(
      await fs.readFile(path.join(projectDir, "package.json"), "utf8")
    );

    if (!pkg.scripts?.start) {
      throw new Error("package.json must have a start script.");
    }

    const port = 41000 + Math.floor(Math.random() * 15000);
    const containerName = `deploydock-${id}`;

    const record = {
      id,
      name,
      status: "starting",
      url: `http://127.0.0.1:${port}`,
      message: "Installing dependencies and starting the app"
    };

    deployments.set(id, record);

    // Fixed container command; the uploaded start script is still
    // untrusted code and must only run in a restricted environment.
    const installAndStart = [
      "if [ -f pnpm-lock.yaml ]; then",
      "corepack enable && pnpm install --frozen-lockfile",
      "elif [ -f package-lock.json ]; then npm ci",
      "else npm install",
      "fi && npm start"
    ].join("; ");

    try {
      await run("docker", [
        "run", "-d",
        "--name", containerName,
        "--memory", "512m",
        "--memory-swap", "512m",
        "--cpus", "1",
        "--pids-limit", "128",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
        "--tmpfs", "/home/node/.npm:rw,nosuid,size=64m",
        "-e", "PORT=3000",
        "-e", "HOST=0.0.0.0",
        "-p", `127.0.0.1:${port}:3000`,
        "-v", `${projectDir}:/workspace:rw`,
        "-w", "/workspace",
        "node:22-alpine",
        "sh", "-lc", installAndStart
      ]);

      record.status = "running";
      record.message =
        "Container started; the app may still be installing dependencies.";
    } catch (error) {
      record.status = "failed";
      record.message = error.message.slice(0, 300);
      return reply.code(500).send({
        error: record.message,
        deployment: record
      });
    }

    return reply.code(201).send(record);
  } catch (error) {
    request.log.error(error);

    if (projectDir) {
      await fs.rm(projectDir, {
        recursive: true,
        force: true
      }).catch(() => {});
    }

    return reply.code(400).send({
      error: error.message || "Deployment failed."
    });
  }
});

app.delete("/api/deployments/:id", async (request, reply) => {
  const { id } = request.params;
  const record = deployments.get(id);

  if (!record) {
    return reply.code(404).send({ error: "Not found." });
  }

  try {
    await run("docker", [
      "rm", "-f", `deploydock-${id}`
    ]).catch(() => {});

    await fs.rm(path.join(DATA, "uploads", id), {
      recursive: true,
      force: true
    });

    deployments.delete(id);
    return { ok: true };
  } catch {
    return reply.code(500).send({
      error: "Could not delete deployment."
    });
  }
});

app.get("/", async (_request, reply) => {
  return reply.type("text/html").send(
    await fs.readFile("./public/index.html", "utf8")
  );
});

app.get("/app.js", async (_request, reply) =>
  reply.type("text/javascript").send(
    await fs.readFile("./public/app.js", "utf8")
  )
);

app.get("/styles.css", async (_request, reply) =>
  reply.type("text/css").send(
    await fs.readFile("./public/styles.css", "utf8")
  )
);

await app.listen({
  port: Number(process.env.PORT || 3000),
  host: "0.0.0.0"
});
