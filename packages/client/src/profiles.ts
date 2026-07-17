import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const connectionProfileSchema = z
  .object({
    endpoint: z.string().min(1).max(2_000),
    token: z.string().min(32).max(2_000),
    allowInsecureRemote: z.boolean().default(false),
  })
  .strict();
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;

const profileFileSchema = z
  .object({
    version: z.literal(1),
    current: z.string().min(1).max(100).nullable(),
    profiles: z.record(z.string(), connectionProfileSchema),
  })
  .strict();

function defaultConfigDirectory(): string {
  const configured = process.env.PRAXRAIL_CONFIG_HOME;
  if (configured) return path.resolve(configured);
  const base =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'praxrail');
}

export class ProfileStore {
  readonly warning =
    'Connection tokens are stored in a mode-0600 fallback file; prefer an OS secret store when available.';
  private readonly filename: string;

  constructor(directory = defaultConfigDirectory()) {
    this.filename = path.join(directory, 'profiles.json');
  }

  async list(): Promise<{
    current: string | null;
    profiles: Record<string, ConnectionProfile>;
  }> {
    try {
      return profileFileSchema.parse(
        JSON.parse(await readFile(this.filename, 'utf8')) as unknown,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return { current: null, profiles: {} };
      }
      throw error;
    }
  }

  async get(name?: string): Promise<ConnectionProfile> {
    const stored = await this.list();
    const selected = name ?? stored.current;
    if (!selected || !stored.profiles[selected]) {
      throw new Error('No Praxrail connection profile is selected');
    }
    return stored.profiles[selected];
  }

  async save(
    name: string,
    profile: ConnectionProfile,
    makeCurrent = true,
  ): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name)) {
      throw new Error('Profile name is invalid');
    }
    const parsed = connectionProfileSchema.parse(profile);
    const stored = await this.list();
    await this.write({
      version: 1,
      current: makeCurrent ? name : stored.current,
      profiles: { ...stored.profiles, [name]: parsed },
    });
  }

  async use(name: string): Promise<void> {
    const stored = await this.list();
    if (!stored.profiles[name])
      throw new Error(`Profile ${name} was not found`);
    await this.write({ version: 1, current: name, profiles: stored.profiles });
  }

  async remove(name: string): Promise<void> {
    const stored = await this.list();
    const profiles = Object.fromEntries(
      Object.entries(stored.profiles).filter(
        ([profileName]) => profileName !== name,
      ),
    );
    if (Object.keys(profiles).length === 0) {
      await rm(this.filename, { force: true });
      return;
    }
    await this.write({
      version: 1,
      current: stored.current === name ? null : stored.current,
      profiles,
    });
  }

  private async write(value: z.input<typeof profileFileSchema>): Promise<void> {
    const parsed = profileFileSchema.parse(value);
    const directory = path.dirname(this.filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      mode: 0o600,
      flag: 'w',
    });
    await rename(temporary, this.filename);
  }
}
