import { html } from "hono/html";

import type { HtmlContent } from "./components.js";
import { layout } from "./components.js";

// Shown on both pages. Bump it whenever either document changes.
const EFFECTIVE_DATE = "9 October 2026";

const CONTACT_EMAIL = "support@notmytempo.dev";

const contact = html`<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`;

const legalPage = (
  title: string,
  login: string | null,
  lede: HtmlContent,
  body: HtmlContent,
) =>
  layout(
    title,
    login,
    html`<article class="legal">
      <header class="page-head">
        <div>
          <span class="eyebrow">Effective ${EFFECTIVE_DATE}</span>
          <h1 class="page-title">${title}</h1>
          <p class="lede">${lede}</p>
        </div>
      </header>
      ${body}
    </article>`,
  );

export const privacyPage = (login: string | null) =>
  legalPage(
    "Privacy Policy",
    login,
    html`What Fletcher reads, what we keep, who else sees it, and how to get it
    deleted.`,
    html`<h2>Who we are</h2>
      <p>
        Not Quite My Tempo (notmytempo.dev, "Fletcher", "we") is a code review
        service run by Parshva Shah, an individual based in India. We decide how
        the data described here is used. Questions, requests, and complaints go
        to ${contact}.
      </p>

      <h2>What we collect</h2>
      <h3>Your GitHub account</h3>
      <p>
        You sign in with GitHub; we don't have passwords. From GitHub we keep
        your numeric user ID and username, the organizations and repositories
        you can reach through the Fletcher GitHub App, and your role in each
        organization. Your avatar is loaded directly from GitHub. We also keep
        the GitHub access token from sign-in, encrypted, and use it only to
        re-check that access every 10 minutes while you're signed in. Sessions
        end after an hour.
      </p>
      <h3>Installations and repositories</h3>
      <p>
        For each account that installs the App: the account name, ID, and type,
        and the names, IDs, and default branches of the repositories it gives
        Fletcher, plus which of them have reviews turned on.
      </p>
      <h3>Pull requests and code</h3>
      <p>
        To review a pull request, Fletcher fetches its title, description, diff,
        and the repository's <code>.fletcher.json</code> file, if there is one,
        and sends them to the AI model provider your workspace uses (see below).
        We don't store the diff or your source files. We do keep what the review
        produced: the verdict, summary, and each finding (file path, line,
        severity, and message, which can quote short pieces of your code). We
        also keep the commit SHA, the pull request number, timing, errors, and
        token counts. Reviews are also posted as comments on the pull request in
        GitHub.
      </p>
      <h3>Your own API keys</h3>
      <p>
        If an admin saves a workspace's own Gemini or Vertex AI key, we check it
        with Google, then store it encrypted (AES-256-GCM). After that, only its
        last 4 characters are shown. We record who saved it and when, and which
        model the workspace chose.
      </p>
      <h3>Billing</h3>
      <p>
        <a href="https://polar.sh">Polar</a> sells the paid plan as merchant of
        record. Polar collects your name, email, billing address, tax details,
        and payment method under its own privacy policy. We never see card
        details. We keep only the Polar customer and subscription IDs, the
        subscription's status, when the current period starts and ends, and how
        many review credits each review used.
      </p>
      <h3>Activity and operations</h3>
      <p>
        We keep an audit log of role, key, and settings changes in each
        workspace (who, what, and when). Our operational logs record event
        names, internal and GitHub IDs, repository names, and error details, but
        not your code. Cloudflare, which hosts the service, processes request
        data such as IP addresses to deliver and protect it.
      </p>

      <h2>Cookies and tracking</h2>
      <p>
        We set one session cookie when you sign in, plus short-lived cookies
        that protect the GitHub sign-in itself. These are strictly necessary, so
        there's no cookie banner. We don't use analytics, advertising, or
        tracking scripts. Pages load fonts from Google Fonts, so your browser
        sends its IP address to Google when fetching them.
      </p>

      <h2>How we use it</h2>
      <ul>
        <li>To review pull requests and show the results in your dashboard.</li>
        <li>
          To decide who can see and change what, based on your GitHub access.
        </li>
        <li>To run the free trial and the paid plan.</li>
        <li>
          To keep the service secure and reliable, for example with the daily
          review limit.
        </li>
        <li>To answer you when you contact us.</li>
      </ul>
      <p>
        We don't sell your data, we don't use it for advertising, and we don't
        use your code to train AI models. Our legal bases are performing our
        contract with you and our legitimate interest in running a secure
        service.
      </p>

      <h2>AI processing</h2>
      <p>
        Reviews are generated by Google's Gemini models, through the Gemini API
        or Vertex AI. Free trial and paid-plan reviews use our Gemini key, which
        is on Google's paid API service and doesn't let Google use prompts or
        responses to train its models. If your workspace uses its own key, your
        account's terms with Google apply instead. Note that on the unpaid tier
        of Google AI Studio, Google may use content to improve its products, so
        use a paid key for private code.
      </p>

      <h2>Who we share it with</h2>
      <p>We use these service providers, and only for running Fletcher:</p>
      <ul>
        <li>
          <strong>GitHub</strong>: sign-in, repository access, and posting
          reviews.
        </li>
        <li>
          <strong>Google</strong>: Gemini API or Vertex AI for reviews, and
          Google Fonts.
        </li>
        <li><strong>Cloudflare</strong>: hosting, database, and network.</li>
        <li>
          <strong>Polar</strong>: checkout, subscriptions, invoices, and tax.
          Polar uses Stripe for payments.
        </li>
      </ul>
      <p>
        These providers may process data in the United States and other
        countries. We'll also disclose data if the law requires it.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>
          Account, workspace, and review history: for as long as the workspace
          exists, or until you ask us to delete it. Uninstalling the App stops
          new reviews but keeps past history unless you ask us to delete it.
        </li>
        <li>
          API keys: until an admin removes or replaces the key in workspace
          settings.
        </li>
        <li>Sessions: one hour, or until you sign out.</li>
        <li>
          Billing records: Polar keeps these for as long as tax and accounting
          law requires.
        </li>
      </ul>

      <h2>Your choices and rights</h2>
      <p>
        You can ask us to access, correct, export, or delete your personal data,
        or object to how we use it. Email ${contact}, and we'll respond within
        30 days. You can stop Fletcher at any time by uninstalling the GitHub
        App or revoking its authorization in your GitHub settings. If you're in
        the EU or UK, you can also complain to your data protection authority.
        If you're in India, the contact above is our grievance contact under the
        Digital Personal Data Protection Act, 2023.
      </p>

      <h2>Security</h2>
      <p>
        Tokens and keys are encrypted at rest. Session cookies hold only random
        tokens, which we store as keyed hashes. Webhooks from GitHub and Polar
        are signature-checked. No system is perfectly secure; if a breach
        affects you, we'll tell you and the relevant authorities as the law
        requires.
      </p>

      <h2>Age</h2>
      <p>
        Fletcher is not for anyone under 16, and we don't knowingly collect
        their data.
      </p>

      <h2>Changes</h2>
      <p>
        We'll post changes here and update the effective date. For material
        changes, we'll also give notice in the app before they take effect.
      </p>`,
  );

export const termsPage = (login: string | null) =>
  legalPage(
    "Terms of Service",
    login,
    html`The agreement between you and Not Quite My Tempo for using Fletcher.`,
    html`<h2>1. The agreement</h2>
      <p>
        These terms are between you and Parshva Shah, an individual in India who
        operates Not Quite My Tempo at notmytempo.dev ("we"). By signing in or
        installing the Fletcher GitHub App, you agree to these terms and to our
        <a href="/privacy">Privacy Policy</a>. If you use Fletcher for an
        organization, you confirm you're allowed to accept these terms for it.
        You must be at least 16.
      </p>

      <h2>2. The service</h2>
      <p>
        Fletcher is a GitHub App that reviews pull requests in the repositories
        you choose, using Google's Gemini AI models, and posts the review as
        comments on the pull request. Workspaces, roles, and access follow your
        GitHub accounts and organizations.
      </p>

      <h2>3. Your code</h2>
      <p>
        Your code stays yours. You give us permission to fetch and process it,
        and to send it to our service providers, only as needed to provide
        Fletcher. You confirm you have the right to install Fletcher on those
        repositories. Reviews Fletcher produces for you are yours to use.
      </p>

      <h2>4. AI reviews</h2>
      <p>
        Reviews are generated by AI and can be wrong, incomplete, or miss
        security problems. They don't replace human review or testing, and
        you're responsible for what you merge. Fletcher's blunt tone is a
        persona, not a judgment of you.
      </p>

      <h2>5. Your own API key</h2>
      <p>
        If your workspace uses its own Gemini or Vertex AI key, Google bills you
        for that usage and its terms apply to it. You're responsible for keeping
        the key valid and within its limits. Reviews on your own key never use
        the paid plan's credits.
      </p>

      <h2>6. Trial, paid plan, and refunds</h2>
      <ul>
        <li>
          Each workspace gets 5 free reviews on our key. The trial is per
          workspace and can't be reset or moved.
        </li>
        <li>
          Polar sells the paid plan as merchant of record, and Polar's terms
          also apply to your purchase. The plan renews automatically each period
          at the price shown at checkout until you cancel.
        </li>
        <li>
          You can cancel any time from the billing portal in workspace settings.
          You keep the plan until the end of the period you've paid for.
        </li>
        <li>
          The paid plan includes a number of review credits each billing period,
          shown on the pricing page. Each review uses credits according to its
          model and size. Unused credits don't carry over, and credits have no
          cash value. A review that fails doesn't use credits. When credits run
          low, reviews may switch to a smaller model from the same provider, and
          once none fits, they stop until the plan renews unless your workspace
          has its own key.
        </li>
        <li>
          Payments are non-refundable, except where the law requires a refund or
          we choose to give one.
        </li>
        <li>
          We'll give at least 30 days' notice before changing the price of an
          existing subscription.
        </li>
        <li>
          Fair use applies. To prevent abuse we limit how many reviews run each
          day, and we may limit usage that's far outside normal use.
        </li>
      </ul>

      <h2>7. Acceptable use</h2>
      <p>Don't use Fletcher to:</p>
      <ul>
        <li>break the law or infringe anyone's rights;</li>
        <li>
          attack, overload, reverse engineer, or get around the limits of the
          service;
        </li>
        <li>resell or share access to our platform key;</li>
        <li>
          process code you have no right to share with us and our service
          providers.
        </li>
      </ul>
      <p>
        You must also follow the terms of GitHub and of Google's Gemini API when
        using Fletcher.
      </p>

      <h2>8. Suspension and ending</h2>
      <p>
        You can stop using Fletcher at any time by uninstalling the GitHub App.
        We may suspend or end access if you break these terms, or if we need to
        in order to protect the service or other users. If we shut down
        Fletcher, we'll give reasonable notice where we can.
      </p>

      <h2>9. Disclaimers</h2>
      <p>
        Fletcher is provided "as is" and "as available". To the extent the law
        allows, we make no warranties, including that it will be uninterrupted,
        error-free, or fit for a particular purpose. We depend on GitHub,
        Google, Cloudflare, and Polar, and we're not responsible for their
        outages.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        To the extent the law allows, we aren't liable for indirect, incidental,
        special, or consequential losses, or for lost profits, data, or
        goodwill. Our total liability for any claim about Fletcher is limited to
        the amount you paid us in the 12 months before the claim, or USD 50 if
        that's more. Nothing in these terms limits liability that can't be
        limited by law, or takes away your rights as a consumer.
      </p>

      <h2>11. Indemnity</h2>
      <p>
        You'll cover our reasonable losses from claims that arise because you
        broke these terms or processed code you had no right to share.
      </p>

      <h2>12. Governing law</h2>
      <p>
        These terms are governed by the laws of India, and the courts of India
        have jurisdiction, unless consumer law in your country gives you the
        right to bring a claim where you live.
      </p>

      <h2>13. Changes</h2>
      <p>
        We may update these terms. We'll post the new version here and update
        the effective date. For material changes, we'll give notice in the app
        at least 14 days before they take effect. If you keep using Fletcher
        after that, you accept the new terms.
      </p>

      <h2>14. Contact</h2>
      <p>Questions about these terms go to ${contact}.</p>`,
  );
