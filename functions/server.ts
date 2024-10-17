// src/docker-server.ts

import Docker from 'dockerode';
import WebSocket, { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import tarStream from 'tar-stream';
import streamifier from 'streamifier';

const docker = new Docker();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

interface ClientConnection {
  ws: WebSocket;
  container?: Docker.Container;
}

interface Message {
  action: string;
  payload?: any;
}

wss.on('connection', (ws: WebSocket) => {
  const client: ClientConnection = { ws };
  console.log('connection started')
  ws.on('message', async (data: WebSocket.RawData) => {
    console.log(data.toString())
    try {
      const message: Message = JSON.parse(data.toString());
      switch (message.action) {
        case 'boot':
          await handleBoot(client, message.payload);
          break;
        case 'teardown':
          await handleTeardown(client);
          break;
        case 'mount':
          await handleMount(client, message.payload);
          break;
        case 'spawn':
          await handleSpawn(client, message.payload);
          break;
        case 'fs.mkdir':
          await handleMkdir(client, message.payload);
          break;
        case 'fs.readdir':
          await handleReaddir(client, message.payload);
          break;
        case 'fs.readFile':
          await handleReadFile(client, message.payload);
          break;
        case 'fs.rename':
          await handleRename(client, message.payload);
          break;
        case 'fs.rm':
          await handleRm(client, message.payload);
          break;
        case 'fs.writeFile':
          await handleWriteFile(client, message.payload);
          break;
        default:
          ws.send(JSON.stringify({ error: `Unknown action: ${message.action}` }));
      }
    } catch (error: any) {
      ws.send(JSON.stringify({ error: error.message }));
    }
  });

  ws.on('close', async () => {
    if (client.container) {
      try {
        await client.container.kill({ signal: 'SIGKILL' });
        await client.container.remove({ force: true });
      } catch (err) {
        console.error('Error cleaning up container:', err);
      }
    }
  });
});

async function handleBoot(client: ClientConnection, payload: any) {
  const { dockerfile } = payload;
  if (!dockerfile) {
    client.ws.send(JSON.stringify({ error: 'Dockerfile content is required for boot.' }));
    return;
  }
  console.log(dockerfile)
  const tar = tarStream.pack();
  tar.entry({ name: 'Dockerfile' }, dockerfile);
  tar.finalize();

  const imageName = `webcontainer`;

  try {
    await new Promise<void>((resolve, reject) => {
      console.log('Container build...')

      docker.buildImage(tar, { t: imageName }, (err, res) => {
        if (err) return reject(err);
        res?.on('data', (data: Buffer) => {
          console.log(data)
          // Optional: Handle build logs if needed
        });
        res?.on('end', () => resolve());
        res?.on('error', (err: any) => reject(err));
      });
    });

    const container = await docker.createContainer({
      Image: imageName,
      Tty: false,
      Cmd: ['/bin/sh'],
      ExposedPorts: { '8080/tcp': {} },
      HostConfig: {
        PortBindings: { '8080/tcp': [{ HostPort: '' }] },
        Binds: ['/workspace'], // Optional: Define bind mounts if needed
      },
    });

    await container.start();
    client.container = container;
    console.log('Container started')
    const inspectInfo = await container.inspect();
    const portBindings = inspectInfo.NetworkSettings.Ports['8080/tcp'];
    const port = portBindings && portBindings.length > 0 ? portBindings[0].HostPort : null;

    client.ws.send(JSON.stringify({ action: 'boot', payload: { port, workdir: '/workspace' } }));
  } catch (error: any) {
    client.ws.send(JSON.stringify({ error: `Boot failed: ${error.message}` }));
  }
}

async function handleTeardown(client: ClientConnection) {
  if (client.container) {
    try {
      await client.container.kill({ signal: 'SIGKILL' });
      await client.container.remove({ force: true });
      client.ws.send(JSON.stringify({ action: 'teardown', payload: { success: true } }));
      client.container = undefined;
    } catch (err: any) {
      client.ws.send(JSON.stringify({ error: `Teardown failed: ${err.message}` }));
    }
  } else {
    client.ws.send(JSON.stringify({ error: 'No container to teardown.' }));
  }
}

async function handleMount(client: ClientConnection, payload: any) {
  if (!client.container) {
    client.ws.send(JSON.stringify({ error: 'Container not booted.' }));
    return;
  }

  const { tree, options } = payload;
  const mountPoint: string = options?.mountPoint || '/workspace';

  try {
    const tar = await createTarFromFileSystemTree(tree);
    await client.container.putArchive(tar, { path: mountPoint });
    client.ws.send(JSON.stringify({ action: 'mount', payload: { success: true } }));
  } catch (error: any) {
    client.ws.send(JSON.stringify({ error: `Mount failed: ${error.message}` }));
  }
}

async function handleSpawn(client: ClientConnection, payload: any) {
  if (!client.container) {
    client.ws.send(JSON.stringify({ error: 'Container not booted.' }));
    return;
  }

  const { command, args, options } = payload;
  const execOptions: Docker.ContainerExecOptions = {
    Cmd: [command, ...args],
    AttachStdout: true,
    AttachStderr: true,
    Tty: options?.terminal ? true : false,
    WorkingDir: options?.cwd || '/workspace',
    Env: options?.env
      ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
      : undefined,
  };

  try {
    const exec = await client.container.exec(execOptions);
    const stream = await exec.start({ hijack: true, stdin: true });

    stream.on('data', (chunk: Buffer) => {
      client.ws.send(JSON.stringify({ action: 'spawn-output', payload: chunk.toString() }));
    });

    stream.on('end', async () => {
      const inspectData = await exec.inspect();
      client.ws.send(JSON.stringify({ action: 'spawn-exit', payload: inspectData.ExitCode }));
    });

    // Handle input stream if needed
    // This implementation does not handle input from the client to the process
  } catch (error: any) {
    client.ws.send(JSON.stringify({ error: `Spawn failed: ${error.message}` }));
  }
}

async function handleMkdir(client: ClientConnection, payload: any) {
  if (!client.container) {
    client.ws.send(JSON.stringify({ error: 'Container not booted.' }));
    return;
  }

  const { path, options } = payload;
  const recursive = options?.recursive || false;
  const cmd = recursive ? ['mkdir', '-p', path] : ['mkdir', path];

  try {
    const exec = await client.container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: '/workspace',
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    let stdout = '';
    let stderr = '';

    stream.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    stream.on('end', async () => {
      const inspectData = await exec.inspect();
      if (inspectData.ExitCode === 0) {
        client.ws.send(JSON.stringify({ action: 'fs.mkdir', payload: { success: true } }));
      } else {
        client.ws.send(
          JSON.stringify({
            error: `mkdir failed with code ${inspectData.ExitCode}: ${stderr || stdout}`,
          })
        );
      }
    });

    stream.on('error', (err: any) => {
      client.ws.send(JSON.stringify({ error: `mkdir stream error: ${err.message}` }));
    });
  } catch (error: any) {
    client.ws.send(JSON.stringify({ error: `mkdir failed: ${error.message}` }));
  }
}

async function handleReaddir(client: ClientConnection, payload: any) {
  if (!client.container) {
    client.ws.send(JSON.stringify({ error: 'Container not booted.' }));
    return;
  }

  const { path, options } = payload;
  const encoding = options?.encoding || 'utf8';
  const withFileTypes = options?.withFileTypes || false;

  try {
    let cmd: string[] = ['ls'];
    if (withFileTypes) {
      cmd = ['ls', '-A', '-1', '--color=never', path];
    } else {
      cmd = ['ls', '-A', '-1', '--color=never', path];
    }

    const exec = await client.container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: '/workspace',
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    let output = '';
    let errorOutput = '';

    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    stream.on('end', async () => {
      const inspectData = await exec.inspect();
      if (inspectData.ExitCode === 0) {
        const entries = output
          .split('\n')
          .filter((line: string) => line.trim() !== '')
          .map((entry: string) => entry.trim());

        if (withFileTypes) {
          const detailedEntries = await Promise.all(
            entries.map(async (entry: string) => {
              const fullPath = `${path}/${entry}`;
              const execStat = await client.container?.exec({
                Cmd: ['stat', '--format=%F', fullPath],
                AttachStdout: true,
                AttachStderr: true,
                Tty: false,
                WorkingDir: '/workspace',
              });
              if (!execStat) return { name: entry, type: 'unknown' };
              const streamStat = await execStat.start({ hijack: true, stdin: false });

              let statOutput = '';
              streamStat.on('data', (chunk: Buffer) => {
                statOutput += chunk.toString();
              });

              await new Promise<void>((resolve) => streamStat.on('end', resolve));

              const type = statOutput.trim();
              let entryType: string;
              if (type.includes('directory')) {
                entryType = 'directory';
              } else if (type.includes('regular file')) {
                entryType = 'file';
              } else {
                entryType = 'other';
              }

              return { name: entry, type: entryType };
            })
          );

          client.ws.send(JSON.stringify({ action: 'fs.readdir', payload: detailedEntries }));
        } else {
          client.ws.send(JSON.stringify({ action: 'fs.readdir', payload: entries }));
        }
      } else {
        client.ws.send(
          JSON.stringify({
            error: `readdir failed with code ${inspectData.ExitCode}: ${errorOutput || output}`,
          })
        );
      }
    });

    stream.on('error', (err: any) => {
      client.ws.send(JSON.stringify({ error: `readdir stream error: ${err.message}` }));
    });
  } catch (error: any) {
    client.ws.send(JSON.stringify({ error: `readdir failed: ${error.message}` }));
  }
}

async function handleReadFile(client: ClientConnection, payload: any) {
  if (!client.container) {
    client.ws.send(JSON.stringify({ error: 'Container not booted.' }));
    return;
  }

  const { path, encoding } = payload;
  const fileEncoding = encoding || 'utf8';

  try {
    const exec = await client.container.exec({
      Cmd: ['cat', path],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: '/workspace',
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    let output = '';
    let errorOutput = '';

    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    stream.on('end', async () => {
      const inspectData = await exec.inspect();
      if (inspectData.ExitCode === 0) {
        client.ws.send(JSON.stringify({ action: 'fs.readFile', payload: output }));
      } else {
        client.ws.send(
          JSON.stringify({
            error: `readFile failed with code ${inspectData.ExitCode}: ${errorOutput || output}`,
          })
        );
      }
    });

    stream.on('error', (err: any) => {
      client.ws.send(JSON.stringify({ error: `readFile stream error: ${err.message}` }));
    });
  } catch (error: any) {
    client.ws.send(JSON.stringify({ error: `readFile failed: ${error.message}` }));
  }
}

async function handleRename(client: ClientConnection, payload: any) {
  if (!client.container) {
    client.ws.send(JSON.stringify({ error: 'Container not booted.' }));
    return;
  }

  const { oldPath, newPath } = payload;
  const cmd = ['mv', oldPath, newPath];

  try {
    const exec = await client.container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: '/workspace',
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    let stdout = '';
    let stderr = '';

    stream.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    stream.on('end', async () => {
      const inspectData = await exec.inspect();
      if (inspectData.ExitCode === 0) {
        client.ws.send(JSON.stringify({ action: 'fs.rename', payload: { success: true } }));
      } else {
        client.ws.send(
          JSON.stringify({
            error: `rename failed with code ${inspectData.ExitCode}: ${stderr || stdout}`,
          })
        );
      }
    });

    stream.on('error', (err: any) => {
      client.ws.send(JSON.stringify({ error: `rename stream error: ${err.message}` }));
    });
  } catch (error: any) {
    client.ws.send(JSON.stringify({ error: `rename failed: ${error.message}` }));
  }
}

async function handleRm(client: ClientConnection, payload: any) {
  if (!client.container) {
    client.ws.send(JSON.stringify({ error: 'Container not booted.' }));
    return;
  }

  const { path, options } = payload;
  const args: string[] = ['rm'];
  if (options?.recursive) args.push('-r');
  if (options?.force) args.push('-f');
  args.push(path);

  try {
    const exec = await client.container.exec({
      Cmd: args,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: '/workspace',
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    let stdout = '';
    let stderr = '';

    stream.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    stream.on('end', async () => {
      const inspectData = await exec.inspect();
      if (inspectData.ExitCode === 0) {
        client.ws.send(JSON.stringify({ action: 'fs.rm', payload: { success: true } }));
      } else {
        client.ws.send(
          JSON.stringify({
            error: `rm failed with code ${inspectData.ExitCode}: ${stderr || stdout}`,
          })
        );
      }
    });

    stream.on('error', (err: any) => {
      client.ws.send(JSON.stringify({ error: `rm stream error: ${err.message}` }));
    });
  } catch (error: any) {
    client.ws.send(JSON.stringify({ error: `rm failed: ${error.message}` }));
  }
}

async function handleWriteFile(client: ClientConnection, payload: any) {
  if (!client.container) {
    client.ws.send(JSON.stringify({ error: 'Container not booted.' }));
    return;
  }

  const { path, data, options } = payload;
  const encoding = options?.encoding || 'utf8';

  try {
    // Create a temporary file with the content
    const tempPath = `/tmp/write_${uuidv4()}.txt`;
    const execEcho = await client.container.exec({
      Cmd: ['sh', '-c', `echo "${escapeShell(data)}" > ${tempPath}`],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: '/workspace',
    });

    const streamEcho = await execEcho.start({ hijack: true, stdin: false });

    let echoOutput = '';
    let echoError = '';

    streamEcho.on('data', (chunk: Buffer) => {
      echoOutput += chunk.toString();
    });

    streamEcho.on('end', async () => {
      const inspectEcho = await execEcho.inspect();
      if (inspectEcho.ExitCode === 0) {
        // Move the temp file to the desired path
        const execMove = await client.container.exec({
          Cmd: ['mv', tempPath, path],
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          WorkingDir: '/workspace',
        });

        const streamMove = await execMove.start({ hijack: true, stdin: false });

        let moveOutput = '';
        let moveError = '';

        streamMove.on('data', (chunk: Buffer) => {
          moveOutput += chunk.toString();
        });

        streamMove.on('end', async () => {
          const inspectMove = await execMove.inspect();
          if (inspectMove.ExitCode === 0) {
            client.ws.send(JSON.stringify({ action: 'fs.writeFile', payload: { success: true } }));
          } else {
            client.ws.send(
              JSON.stringify({
                error: `writeFile move failed with code ${inspectMove.ExitCode}: ${moveError || moveOutput}`,
              })
            );
          }
        });

        streamMove.on('error', (err: any) => {
          client.ws.send(JSON.stringify({ error: `writeFile move stream error: ${err.message}` }));
        });
      } else {
        client.ws.send(
          JSON.stringify({
            error: `writeFile echo failed with code ${inspectEcho.ExitCode}: ${echoError || echoOutput}`,
          })
        );
      }
    });

    streamEcho.on('error', (err: any) => {
      client.ws.send(JSON.stringify({ error: `writeFile echo stream error: ${err.message}` }));
    });
  } catch (error: any) {
    client.ws.send(JSON.stringify({ error: `writeFile failed: ${error.message}` }));
  }
}

function escapeShell(input: string): string {
  return input.replace(/(["'$`\\])/g, '\\$1');
}

async function createTarFromFileSystemTree(tree: FileSystemTree, prefix: string = ''): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const pack = tarStream.pack();
    const chunks: Buffer[] = [];

    pack.on('error', (err) => reject(err));
    pack.on('entry', (header, stream, next) => {
      stream.on('end', next);
      stream.on('error', (err) => reject(err));
    });

    pack.on('finish', () => {
      resolve(Buffer.concat(chunks));
    });

    const appendEntries = (currentTree: FileSystemTree, currentPath: string) => {
      for (const [name, node] of Object.entries(currentTree)) {
        const entryPath = prefix ? `${prefix}/${name}` : name;
        if ('file' in node) {
          const buffer = Buffer.from(node.file.contents);
          pack.entry({ name: entryPath, size: buffer.length }, buffer);
        } else if ('directory' in node) {
          pack.entry({ name: `${entryPath}/`, type: 'directory' }, null, () => {
            appendEntries(node.directory, entryPath);
          });
        }
      }
    };

    appendEntries(tree, '');
    pack.finalize();
  });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Docker WebContainer API Server is listening on port ${PORT}`);
});
