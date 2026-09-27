import Base from "@axe-core/playwright"

/** Axe as every browser spec runs it. */
export default class AxeBuilder extends Base {
  constructor(options: ConstructorParameters<typeof Base>[0]) {
    super(options)
    // The owner's decision: page zoom is off on purpose in the editor app; text size is adjustable in Settings > Reading.
    this.disableRules(["meta-viewport"])
  }
}
