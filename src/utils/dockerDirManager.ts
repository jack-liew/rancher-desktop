import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import Logging from '@/utils/logging';

const console = Logging.background;

/**
 * Goes under the `auths` key in docker config.json.
 */
type AuthConfig = {
  username?: string,
  password?: string,
  auth?: string,
  email?: string,
  serveraddress?: string,
  identitytoken?: string,
  registrytoken?: string,
}

/**
 * The parts of a docker config.json file that concern Rancher Desktop.
 */
type PartialDockerConfig = {
  auths?: Record<string, AuthConfig>,
  credsStore?: string,
  credHelpers?: Record<string, string>,
  currentContext?: string,
}

/**
 * Manages everything under the docker CLI config directory (except, at
 * the time of writing, docker CLI plugins).
 */
export default class DockerDirManager {
  protected readonly dockerDirPath: string;
  protected readonly dockerContextDirPath: string;
  /**
   * Path to the 'rancher-desktop' docker context file.  The parent directory
   * is the SHA256 hash of the docker context name ('rancher-desktop'), per the
   * docker convention.
   */
  protected readonly dockerContextPath: string;
  protected readonly dockerConfigPath: string;
  protected readonly defaultDockerSockPath = '/var/run/docker.sock';
  protected readonly contextName = 'rancher-desktop';

  /**
   * @param dockerDirPath The path to the directory containing docker CLI config.
   */
  constructor(dockerDirPath: string) {
    this.dockerDirPath = dockerDirPath;
    this.dockerContextDirPath = path.join(this.dockerDirPath, 'contexts', 'meta');
    this.dockerContextPath = path.join(this.dockerContextDirPath,
      'b547d66a5de60e5f0843aba28283a8875c2ad72e99ba076060ef9ec7c09917c8', 'meta.json');
    this.dockerConfigPath = path.join(this.dockerDirPath, 'config.json');
    console.debug(`Created new DockerDirManager to manage dir: ${ this.dockerDirPath }`);
  }

  /**
   * Gets the docker CLI config.json file as an object.
   */
  protected async readDockerConfig(): Promise<PartialDockerConfig> {
    try {
      const rawConfig = await fs.promises.readFile(this.dockerConfigPath, { encoding: 'utf-8' });

      return JSON.parse(rawConfig);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return {};
    }
  }

  /**
   * Writes the docker CLI config.json file.
   * @param config An object that is the config we want to write.
   */
  protected async writeDockerConfig(config: PartialDockerConfig): Promise<void> {
    const rawConfig = JSON.stringify(config);

    await fs.promises.mkdir(this.dockerDirPath, { recursive: true });
    await fs.promises.writeFile(this.dockerConfigPath, rawConfig, { encoding: 'utf-8' });
  }

  /**
   * Read the docker configuration, and return the docker socket in use by the
   * current context.  If the context is invalid, return the default socket
   * location.
   * @param currentContext Docker's current context, as set in the configs.
   */
  async getCurrentDockerSocket(currentContext?: string): Promise<string> {
    const defaultSocket = `unix://${ this.defaultDockerSockPath }`;

    if (!currentContext) {
      return defaultSocket;
    }

    for (const dir of await fs.promises.readdir(this.dockerContextDirPath)) {
      const contextPath = path.join(this.dockerContextDirPath, dir, 'meta.json');

      try {
        const data = yaml.parse(await fs.promises.readFile(contextPath, 'utf-8'));

        if (data.Name === currentContext) {
          return data.Endpoints?.docker?.Host as string ?? defaultSocket;
        }
      } catch (ex) {
        console.log(`Failed to read context ${ dir }, skipping: ${ ex }`);
      }
    }

    // If we reach here, the current context is invalid.
    return defaultSocket;
  }

  /**
   * Given some information about state external to this method, returns the
   * name of the context that should be used. Follows these rules, in order of preference:
   * 1. If we have control of the default socket (`/var/run/docker.sock`), return a value
   *    that refers to the default context, which uses the default socket.
   *    This should have the widest compatibility.
   * 2. Return the passed current context if:
   *    - The current context uses a valid unix socket - the user is probably using it.
   *    - The current context uses a non-unix socket (e.g. tcp) - we can't check if it's valid.
   * 3. The current context is invalid, so return our context ("rancher-desktop").
   * @param weOwnDefaultSocket Whether Rancher Desktop has control over the default socket.
   * @param currentContext The current context.
   * @returns Undefined for default context; string containing context name for other contexts.
   */
  async getDesiredDockerContext(weOwnDefaultSocket: boolean, currentContext: string | undefined): Promise<string | undefined> {
    if (weOwnDefaultSocket) {
      return undefined;
    }

    if (!currentContext) {
      return this.contextName;
    }

    if (currentContext === this.contextName) {
      return this.contextName;
    }

    const currentSocketUri = await this.getCurrentDockerSocket(currentContext);

    if (!currentSocketUri.startsWith('unix://')) {
      // Using a non-unix socket (e.g. TCP); assume it's working fine.
      return currentContext;
    }

    const currentSocketPath = currentSocketUri.replace(/^unix:\/\//, '');

    try {
      if ((await fs.promises.stat(currentSocketPath)).isSocket()) {
        return currentContext;
      }
      console.log(`Invalid existing context "${ currentContext }": ${ currentSocketUri } is not a socket; overriding context.`);
    } catch (ex) {
      console.log(`Could not read existing docker socket ${ currentSocketUri }, overriding context "${ currentContext }": ${ ex }`);
    }

    return this.contextName;
  }

  /**
   * Determines whether the passed credential helper is working.
   * @param helperName The cred helper name, without the "docker-credential-" prefix.
   */
  credHelperWorking(helperName: string): Promise<boolean> {
    const helperBin = `docker-credential-${ helperName }`;
    const logMsg = `Credential helper "${ helperBin }" is not functional`;
    let proc: any;

    try {
      proc = spawn(helperBin, ['list']);
    } catch {
      console.log(logMsg);

      return Promise.resolve(false);
    }

    return new Promise( (resolve) => {
      proc.on('exit', (code: number) => {
        if (code) {
          console.log(logMsg);
          resolve(false);
        }
        resolve(true);
      });
    });
  }

  /**
   * Returns the default cred helper name for the current platform.
   */
  getDefaultDockerCredsStore(): string {
    const platform = os.platform();

    if (platform.startsWith('win')) {
      return 'wincred';
    } else if (platform === 'darwin') {
      return 'osxkeychain';
    } else if (platform === 'linux') {
      return 'secretservice';
    } else {
      throw new Error(`platform "${ platform }" is not supported`);
    }
  }

  /**
   * Ensures that the rancher-desktop docker context exists.
   * @param socketPath Path to the rancher-desktop specific docker socket.
   * @param kubernetesEndpoint Path to rancher-desktop Kubernetes endpoint.
   */
  async ensureDockerContext(socketPath: string, kubernetesEndpoint?: string): Promise<void> {
    const contextContents = {
      Name:      this.contextName,
      Metadata:  { Description: 'Rancher Desktop moby context' },
      Endpoints: {
        docker: {
          Host:          `unix://${ socketPath }`,
          SkipTLSVerify: false,
        },
      } as Record<string, {Host: string, SkipTLSVerify: boolean, DefaultNamespace?: string}>,
    };

    if (kubernetesEndpoint) {
      contextContents.Endpoints.kubernetes = {
        Host:             kubernetesEndpoint,
        SkipTLSVerify:    true,
        DefaultNamespace: 'default',
      };
    }

    console.debug(`Updating docker context: writing to ${ this.dockerContextPath }`, contextContents);

    await fs.promises.mkdir(path.dirname(this.dockerContextPath), { recursive: true });
    await fs.promises.writeFile(this.dockerContextPath, JSON.stringify(contextContents));
  }

  /**
   * Clear the docker context; this is used for factory reset.
   */
  async clearDockerContext(): Promise<void> {
    try {
      await fs.promises.rm(path.dirname(this.dockerContextPath), { recursive: true, force: true });

      const config = await this.readDockerConfig();

      if (config?.currentContext !== this.contextName) {
        return;
      }
      delete config.currentContext;
      await this.writeDockerConfig(config);
    } catch (ex) {
      // Ignore the error; there really isn't much we can usefully do here.
      console.debug(`Ignoring error when clearing docker context: ${ ex }`);
    }
  }

  /**
   * Ensures that the state of everything under the docker CLI config directory
   * is correct.
   * @param weOwnDefaultSocket Whether Rancher Desktop has control over the default socket.
   * @param socketPath Path to the rancher-desktop specific docker socket.
   * @param kubernetesEndpoint Path to rancher-desktop Kubernetes endpoint.
   */
  async ensureDockerConfig(weOwnDefaultSocket: boolean, socketPath?: string, kubernetesEndpoint?: string): Promise<void> {
    // read current config
    const currentConfig = await this.readDockerConfig();

    console.log(`Read existing docker config: ${ JSON.stringify(currentConfig) }`);
    const newConfig = JSON.parse(JSON.stringify(currentConfig));

    // ensure docker context is set as we want
    const platform = os.platform();

    if ((platform === 'darwin' || platform === 'linux') && socketPath) {
      await this.ensureDockerContext(socketPath, kubernetesEndpoint);
    }
    newConfig.currentContext = await this.getDesiredDockerContext(weOwnDefaultSocket, currentConfig.currentContext);

    // ensure we are using a valid credential helper
    if (!newConfig.credsStore) {
      newConfig.credsStore = this.getDefaultDockerCredsStore();
    } else if (newConfig.credsStore === 'desktop' && !(await this.credHelperWorking(newConfig.credsStore))) {
      newConfig.credsStore = this.getDefaultDockerCredsStore();
    }

    // write config if modified
    if (JSON.stringify(newConfig) !== JSON.stringify(currentConfig)) {
      console.log(`Writing modified docker config: ${ JSON.stringify(newConfig) }`);
      await this.writeDockerConfig(newConfig);
    } else {
      console.log('Docker config not modified');
    }
  }
}
