export class HistoryRestoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HistoryRestoreError"
  }
}
