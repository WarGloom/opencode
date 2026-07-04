declare module "@lydell/node-pty" {
  type Disposable = {
    dispose(): void
  }

  type Event<T> = (listener: (event: T) => void) => Disposable

  type ForkOptions = {
    name?: string
    cols?: number
    rows?: number
    cwd?: string
    env?: Record<string, string | undefined>
  }

  type ExitEvent = {
    exitCode: number
    signal?: number | string
  }

  type Pty = {
    readonly pid: number
    readonly onData: Event<string>
    readonly onExit: Event<ExitEvent>
    write(data: string): void
    resize(columns: number, rows: number): void
    kill(signal?: string): void
  }

  export function spawn(file: string, args: string[] | string, options: ForkOptions): Pty
}
