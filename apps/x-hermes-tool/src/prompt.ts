import readline from "node:readline/promises";

export interface PromptIo {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

export function isInteractive(io: PromptIo): boolean {
  return Boolean(io.input.isTTY && io.output.isTTY);
}

export async function promptText(
  io: PromptIo,
  label: string,
  options: { defaultValue?: string; required?: boolean } = {}
): Promise<string> {
  const suffix = options.defaultValue ? ` [${options.defaultValue}]` : "";
  const rl = readline.createInterface({
    input: io.input,
    output: io.output
  });

  try {
    while (true) {
      const answer = (await rl.question(`${label}${suffix}: `)).trim();
      const value = answer || options.defaultValue || "";
      if (value || !options.required) {
        return value;
      }
      io.output.write("A value is required.\n");
    }
  } finally {
    rl.close();
  }
}

export async function promptConfirm(
  io: PromptIo,
  label: string,
  options: { defaultValue?: boolean } = {}
): Promise<boolean> {
  const defaultValue = options.defaultValue ?? false;
  const suffix = defaultValue ? " [Y/n]" : " [y/N]";
  const answer = (
    await promptText(io, label + suffix, {
      required: false
    })
  ).toLowerCase();

  if (!answer) {
    return defaultValue;
  }
  return answer === "y" || answer === "yes";
}

export async function promptSecret(
  io: PromptIo,
  label: string,
  options: { required?: boolean } = {}
): Promise<string> {
  while (true) {
    const value = await readHiddenLine(io, `${label}: `);
    if (value || !options.required) {
      return value;
    }
    io.output.write("A value is required.\n");
  }
}

async function readHiddenLine(io: PromptIo, label: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const input = io.input;
    const output = io.output;
    const wasRaw = input.isRaw;
    let value = "";

    const cleanup = () => {
      input.off("data", onData);
      if (input.setRawMode) {
        input.setRawMode(wasRaw);
      }
      input.pause();
    };

    const finish = () => {
      cleanup();
      output.write("\n");
      resolve(value);
    };

    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          fail(new Error("Prompt cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    output.write(label);
    input.resume();
    if (input.setRawMode) {
      input.setRawMode(true);
    }
    input.on("data", onData);
  });
}

