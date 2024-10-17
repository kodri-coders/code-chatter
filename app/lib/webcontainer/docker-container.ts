// src/docker-container.ts

import { EventEmitter } from 'events';

interface BootOptions {
  coep?: 'require-corp' | 'credentialless' | 'none';
  workdirName?: string;
  forwardPreviewErrors?: boolean | 'exceptions-only';
  dockerfile: string;
}

interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | number | boolean>;
  output?: boolean;
  terminal?: { cols: number; rows: number };
}

interface MountOptions {
  mountPoint?: string;
}

interface WebContainerProcess {
  exit: Promise<number>;
  input: WritableStream<string>;
  output: ReadableStream<string>;
  kill(): void;
  resize(dimensions: { cols: number; rows: number }): void;
}

type Listener = (...args: any[]) => void;

export class DockerContainer extends EventEmitter {
  private ws: WebSocket;
  private isBooted: boolean = false;
  private listeners: Map<string, Listener[]> = new Map();

  constructor(serverUrl: string) {
    super();
    this.ws = new WebSocket(serverUrl);

    this.ws.addEventListener('message', ({data}) => {
      console.log(data)
      const message = JSON.parse(data.toString());
      this.emit(message.action, message.payload);
    });

    this.ws.addEventListener('open', () => {
      this.emit('open');
    });

    this.ws.addEventListener('close', () => {
      this.emit('close');
    });

    this.ws.addEventListener('error', (error) => {
      this.emit('error', error);
    });
  }

  static async boot(options: BootOptions): Promise<DockerContainer> {
    const client = new DockerContainer('ws://localhost:8080');

    await new Promise<void>((resolve, reject) => {
      client.ws.addEventListener('open', () => {
        client.sendMessage('boot', { dockerfile: options.dockerfile });
        resolve();
      });

      client.ws.addEventListener('error', (err) => {
        reject(err);
      });
    });

    client.on('boot', (payload) => {
      client.isBooted = true;
      client.emit('booted', payload);
    });

    return client;
  }

  async mount(tree: any, options?: MountOptions): Promise<void> {
    this.sendMessage('mount', { tree, options });
    return new Promise((resolve, reject) => {
      this.once('mount', (payload) => {
        if (payload.success) resolve();
        else reject(payload.error);
      });
    });
  }

  onEvent(event: string, listener: Listener): () => void {
    this.on(event, listener);
    return () => this.off(event, listener);
  }

  async spawn(command: string, args: string[] = [], options?: SpawnOptions): Promise<WebContainerProcess> {
    this.sendMessage('spawn', { command, args, options });

    const process: WebContainerProcess = {
      exit: new Promise<number>((resolve, reject) => {
        this.once('spawn-exit', (code: number) => {
          resolve(code);
        });
      }),
      input: new WritableStream<string>({
        write(chunk) {
          // Implement sending input to the process
        },
      }),
      output: new ReadableStream<string>({
        start: (controller) => {
          this.on('spawn-output', (data: string) => {
            controller.enqueue(data);
          });
        },
      }),
      kill: () => {
        // Implement kill process
      },
      resize: (dimensions: { cols: number; rows: number }) => {
        // Implement resize terminal
      },
    };

    return process;
  }

  teardown(): void {
    this.sendMessage('teardown');
  }

  private sendMessage(action: string, payload?: any) {
    this.ws.send(JSON.stringify({ action, payload }));
  }
}