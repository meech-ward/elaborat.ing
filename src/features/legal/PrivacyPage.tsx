import { LegalPage, OutLink, SOURCE_REPOSITORY } from "./LegalPage"

// Generic text for the hosted copy, meant to be read by the person who runs
// it before relying on it (docs/self-host.md says so).

/** What the hosted copy keeps about people, where, and how they take it with them or remove it. */
export function PrivacyPage() {
  return (
    <LegalPage title="Privacy" updated={{ iso: "2026-09-30", text: "September 30, 2026" }}>
      <p>
        elaborat.ing is an open-source app run by one person, not a company. This page says what the copy at elaborat.ing keeps about you, where it
        keeps it, and how to take it with you or remove it.
      </p>

      <h2>What is stored</h2>
      <ul>
        <li>Your account: your email address, the name you set in Settings (if you set one), and how you sign in, such as a passkey or a GitHub or Google sign-in.</li>
        <li>Your projects: their files and folders (notes, drawings and diagrams), each file's history, a search index made from them, and the people you share them with.</li>
        <li>Comments you write, with your name.</li>
        <li>Agent connections: the agents you connect to your account, such as Claude or ChatGPT, until you disconnect them.</li>
        <li>Short-lived technical logs, such as IP addresses and times of requests, which the services below keep to run and protect the site.</li>
      </ul>
      <p>Without an account, nothing you write leaves your browser.</p>

      <h2>Why it is kept</h2>
      <ul>
        <li>Your account: to sign you in, send you sign-in codes and invitations, and show your name on your comments and in shared projects.</li>
        <li>Your projects and comments: to save them, keep them in step on your devices, search them, and show them to the people you share them with and the agents you connect.</li>
        <li>Technical logs: to run the site, fix problems and stop abuse.</li>
      </ul>

      <h2>Where it is stored</h2>
      <ul>
        <li>Supabase, in the United States, holds the database, sign-in and your files.</li>
        <li>
          Cloudflare serves the site, and its Web Analytics counts page views without cookies and without identifying you.
        </li>
        <li>Amazon Web Services (SES) sends the app's emails, such as sign-in links and invitations.</li>
      </ul>
      <p>They handle this data only to run the app.</p>

      <h2>Who else sees it</h2>
      <ul>
        <li>People you share a project with see its files, their history and its comments, and the name and email of everyone in it.</li>
        <li>
          The agents you connect, such as Claude or ChatGPT, read and change your projects as you ask them to. What they read goes to the company
          that runs the agent, such as Anthropic or OpenAI, under that company's own privacy policy.
        </li>
      </ul>

      <h2>What is never done with it</h2>
      <p>
        Your data is not sold, and there are no ads or advertising trackers. The person who runs the app can reach the database, and looks at your data
        only to fix a problem, when you ask for help, or when the law requires it.
      </p>

      <h2>Cookies and browser storage</h2>
      <p>
        The app keeps a few things in your browser: your sign-in session, your settings, and offline copies of your projects, so you can keep working
        without a connection. None of it is used for advertising or tracking.
      </p>

      <h2>Download or delete your data</h2>
      <ul>
        <li>Any project downloads as a .zip of its files: choose Download project in its menu.</li>
        <li>Delete a project from its menu, or your whole account in Settings, under Account. Deleting your account deletes the projects you own (you can hand a shared one to another member first); your comments on other projects stay, shown as from a deleted account.</li>
        <li>Disconnect an agent on the Connected agents page.</li>
      </ul>

      <h2>How long it is kept</h2>
      <ul>
        <li>Your account, projects, comments and each file's history: until you delete them. A deleted file stays in its project's history until the project is deleted.</li>
        <li>Agent connections: until you disconnect them or delete your account.</li>
        <li>Technical logs: a short time, after which the services above delete them.</li>
      </ul>
      <p>Backups kept by the database provider may hold deleted data for a short time before they expire.</p>

      <h2>Changes</h2>
      <p>When this page changes, the date at the top changes too.</p>

      <h2>Contact</h2>
      <p>
        Questions or requests: open an issue on the <OutLink href={`${SOURCE_REPOSITORY}/issues`}>GitHub repository</OutLink>.
      </p>
    </LegalPage>
  )
}
