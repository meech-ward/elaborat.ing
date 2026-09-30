import { LegalPage, OutLink, SOURCE_REPOSITORY } from "./LegalPage"

// Generic text for the hosted copy, meant to be read by the person who runs
// it before relying on it (docs/self-host.md says so).

/** The terms of using the hosted copy. */
export function TermsPage() {
  return (
    <LegalPage title="Terms" updated={{ iso: "2026-09-28", text: "September 28, 2026" }}>
      <p>These terms cover using the copy of elaborat.ing at elaborat.ing. By using it, you agree to them.</p>

      <h2>Provided as is</h2>
      <p>
        elaborat.ing is an open-source app run by one person. It is provided as is, without warranties of any kind: it may have bugs, be unavailable,
        change or stop, and it could lose data. Keep your own copy of anything important (any project downloads as a .zip). As far as the law allows, the
        person who runs it is not liable for any loss that comes from using it.
      </p>

      <h2>Acceptable use</h2>
      <p>Don't use elaborat.ing to:</p>
      <ul>
        <li>harass, threaten or abuse anyone, or send spam;</li>
        <li>store or share anything illegal, or anything you have no right to share;</li>
        <li>attack, probe or overload the service, or get into accounts or data that are not yours.</li>
      </ul>

      <h2>Your content</h2>
      <p>
        What you write, draw and upload stays yours. You let the app store it, show it and work on it only to provide the service to you, to the people
        you share it with, and to the agents you connect.
      </p>

      <h2>Accounts</h2>
      <p>
        You are responsible for what happens with your account, including what the agents you connect do. An account used for abuse, or against these
        terms, can be suspended or removed.
      </p>

      <h2>The code</h2>
      <p>
        The app's code is open source under the <OutLink href={`${SOURCE_REPOSITORY}/blob/main/LICENSE`}>MIT License</OutLink>. The license covers the
        code; these terms cover using this copy of the service.
      </p>

      <h2>Changes</h2>
      <p>These terms may change. When they do, the date at the top changes too, and using the app afterwards means you accept them.</p>

      <h2>Contact</h2>
      <p>
        Questions: open an issue on the <OutLink href={`${SOURCE_REPOSITORY}/issues`}>GitHub repository</OutLink>.
      </p>
    </LegalPage>
  )
}
