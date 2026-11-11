import { GhuriError } from './errors'

export class CommandError extends GhuriError {
  constructor(
    message: string,
    readonly returncode = 1,
  ) {
    super(message)
  }
}

export interface ArgumentSpec {
  name: string
  help?: string
  required?: boolean
  variadic?: boolean
  default?: unknown
}

export interface OptionSpec {
  /** e.g. '--remote', '-n, --name <value>', '--no-input' */
  flags: string
  help?: string
  default?: unknown
}

/** Minimal parser description; the CLI turns it into real argv parsing. */
export class ArgumentParser {
  readonly arguments: ArgumentSpec[] = []
  readonly options: OptionSpec[] = []

  argument(name: string, opts: Omit<ArgumentSpec, 'name'> = {}): this {
    this.arguments.push({ name, ...opts })
    return this
  }

  option(flags: string, opts: Omit<OptionSpec, 'flags'> = {}): this {
    this.options.push({ flags, ...opts })
    return this
  }
}

export interface CommandStyle {
  success(s: string): string
  warning(s: string): string
  error(s: string): string
  notice(s: string): string
  bold(s: string): string
}

export interface CommandIO {
  stdout(msg: string): void
  stderr(msg: string): void
  style: CommandStyle
  /** Interactive prompt. Undefined when running non-interactively. */
  prompt?(question: string, opts?: { password?: boolean; default?: string }): Promise<string>
  confirm?(question: string, opts?: { default?: boolean }): Promise<boolean>
}

/** Django's BaseCommand. */
export abstract class BaseCommand {
  static help = ''
  addArguments?(parser: ArgumentParser): void
  abstract handle(args: Record<string, unknown>, io: CommandIO): Promise<void | number>
}

export type CommandClass = (new () => BaseCommand) & { help?: string }

export class CommandRegistry {
  private commands = new Map<string, CommandClass>()

  register(name: string, cls: CommandClass): void {
    this.commands.set(name, cls)
  }

  get(name: string): CommandClass | undefined {
    return this.commands.get(name)
  }

  all(): Map<string, CommandClass> {
    return new Map(this.commands)
  }
}

const KEY = Symbol.for('ghuri.core.commands')
export const commandRegistry: CommandRegistry = ((globalThis as any)[KEY] ??= new CommandRegistry())

const identity = (s: string) => s
export const plainStyle: CommandStyle = {
  success: identity,
  warning: identity,
  error: identity,
  notice: identity,
  bold: identity,
}

/** IO that collects output — handy for tests (`callCommand`). */
export function bufferIO(): CommandIO & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, stdout: (m) => out.push(m), stderr: (m) => err.push(m), style: plainStyle }
}

/** Run a command programmatically (Django's call_command). */
export async function callCommand(
  nameOrClass: string | CommandClass,
  args: Record<string, unknown> = {},
  io: CommandIO = bufferIO(),
): Promise<void | number> {
  const cls = typeof nameOrClass === 'string' ? commandRegistry.get(nameOrClass) : nameOrClass
  if (!cls) throw new CommandError(`Unknown command: '${String(nameOrClass)}'`)
  return new cls().handle(args, io)
}
