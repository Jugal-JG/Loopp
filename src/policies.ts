export const POLICY_VERSION = '2026-11-4';
export const publicPlanDocuments = ['pro-admin', 'basic-admin', 'pro-billing', 'basic-billing'];

export const policies = [
  { id: 'pro-billing', tier: 'Pro', markdown: `# Pro billing
## Refund eligibility
Pro monthly customers with an active contract can request a full refund of the most recent charge within 14 days of billing, up to $50. Annual contracts and expired contracts are excluded. A refund requires explicit confirmation and each invoice can be refunded once.

## Billing receipts
Pro customers can find receipts under Settings, Billing, then Invoices. Choose the invoice and select Download receipt.` },
  { id: 'basic-billing', tier: 'Basic', markdown: `# Basic billing
## Refund eligibility
Basic charges require human review for a refund. Automated refunds are unavailable on this tier.

## Billing receipts
Basic customers can find receipts under Settings, Billing, then Invoices. Choose the invoice and select Download receipt.` },
  { id: 'access', tier: 'All', markdown: `# Workspace access
## Password reset
From the sign-in page, choose Forgot password and enter the email on your account. Check your spam folder if the message has not arrived in five minutes.

## Invite troubleshooting
Ask a workspace admin to open Settings and select Members. They can resend a pending invitation. Confirm that the invitation email matches the address you use to sign in.` },
  { id: 'subscription', tier: 'All', markdown: `# Subscriptions
## Cancel renewal
A workspace owner can turn off renewal in Settings, Billing, then Manage subscription. Access continues until the end of the current billing period. Canceling renewal does not automatically refund a prior charge.` },
  { id: 'payments', tier: 'All', markdown: `# Payments and invoicing
## Change payment card
A workspace owner can open Settings, Billing, then Payment method and select Replace card. Future charges use the new card. Existing receipts keep the original payment information.

## Failed payment and grace period
When an automatic card payment fails, the workspace has a seven-day grace period from the first failed attempt. A workspace owner can replace the card in Billing and use Retry payment. At the end of the grace period, the workspace becomes read-only until payment clears.

## Billing address and tax ID
Workspace owners can update the billing address, legal name, and tax ID under Settings, Billing, then Billing details. Updates apply to future invoices. Contact support to review corrections to invoices already issued.

## Duplicate card charges
Compare invoice numbers in Billing before reporting a duplicate. A pending authorization can appear next to the posted payment for up to five business days. If two payments have posted for the same invoice, provide the invoice number to support for review. Never share a full card number.` },
  { id: 'plans', tier: 'All', markdown: `# Plans and seats
## Upgrade a subscription
A workspace owner can choose Change plan under Settings, Billing, then Manage subscription. An upgrade starts immediately after confirmation. The checkout screen shows the prorated charge before the owner confirms.

## Downgrade a subscription
Workspace owners can schedule a downgrade from Manage subscription. It takes effect at the next renewal. Before that date, reduce active seats to the new plan's limit and export features that the new plan does not include.

## Add or remove seats
Admins invite new members from Settings, Members. A paid seat added mid-cycle is prorated. Removing a member revokes access immediately. The associated seat reduction takes effect at the next renewal.

## Switch to annual billing
Workspace owners can select annual billing in Manage subscription. The annual billing term starts at the next renewal. Review the total and effective date on the confirmation screen.` },
  { id: 'membership', tier: 'All', markdown: `# Workspace membership
## Transfer workspace ownership
The current owner can open Settings, Members, select an active admin, and choose Transfer ownership. The recipient must accept the transfer by email. The workspace always needs an owner.

## Workspace roles
Owners control billing and ownership. Admins manage settings and membership. Members work in projects where they have access. Guests can access only the projects shared with them.

## Remove workspace access
An admin can select a member under Settings, Members and choose Remove. This revokes access immediately. Content created by that member stays in shared projects. Only the current owner can initiate an ownership transfer.` },
  { id: 'security', tier: 'All', markdown: `# Account security
## Set up two-factor authentication
Open Profile, Security, and select Enable two-factor authentication. Scan the QR code using an authenticator app and enter its verification code. Store your recovery codes in a secure location.

## Lost authenticator access
At sign-in, select Use a recovery code and enter an unused code. After signing in, reset two-factor authentication under Profile, Security. If no recovery code is available, ask support for an identity review.

## Sign out other sessions
Open Profile, Security, and choose Active sessions. You can revoke individual sessions or sign out all other sessions. If you suspect unauthorized access, change your password and review active sessions.

## Suspicious account activity
Change the account password, revoke unfamiliar sessions, and alert a workspace admin. Contact support with the approximate time and affected account. Keep passwords, recovery codes, and authentication tokens private.` },
  { id: 'data', tier: 'All', markdown: `# Workspace data
## Export workspace data
A workspace owner can request an export under Settings, Data management, then Export workspace. The download link is emailed when ready and expires after 24 hours. An export can take up to one business day.

## Restore a deleted project
An admin can restore a deleted project from Settings, Data management, then Trash for 30 days after deletion. After 30 days, project contents are permanently removed.

## Delete a workspace
Only the workspace owner can request deletion under Settings, Data management. The workspace is disabled immediately and remains recoverable for 30 days. Export needed data before confirming deletion.

## Close a personal account
Request account closure under Profile, Privacy. Transfer any workspace you own first. Shared project content remains with the workspace. Personal account deletion is processed within 30 days.` },
  { id: 'troubleshooting', tier: 'All', markdown: `# App troubleshooting
## Blank dashboard or loading loop
Refresh Loopp and try a private browser window. If it loads there, disable browser extensions and clear Loopp site data. If the problem persists, send support the browser version and approximate error time.

## Upload limits and failures
Each upload can be up to 100 MB. Loopp accepts PDF, PNG, JPEG, CSV, and ZIP files. If an allowed upload fails, retry on a stable connection and check that project permissions allow editing.

## Notifications are missing
Check Profile, Notifications for your email and in-app preferences. Confirm your email address and check Spam. Muted projects only send direct mentions. Project notification settings are available from the project menu.

## Supported browsers
Loopp supports the current and previous versions of Chrome, Edge, Firefox, and Safari. Update your browser if a page does not load. Some extensions can interfere with sign-in or file uploads.` },
  { id: 'pro-admin', tier: 'Pro', markdown: `# Pro administration
## SAML single sign-on
On Pro, owners can open Settings, Security, then Single sign-on to configure SAML. Enter your identity provider metadata and run Test connection with a second admin before requiring SSO for everyone.

## Audit logs
Pro workspace admins can open Settings, Security, then Audit log. The log retains 90 days of membership, permission, and security events. Admins can download the filtered results as CSV.

## Priority support
Pro has priority email support with a four-business-hour initial response target during support hours, Monday through Friday, 9 a.m. to 6 p.m. Eastern time. Provide the workspace name and a short description of the issue.` },
  { id: 'basic-admin', tier: 'Basic', markdown: `# Basic administration
## Single sign-on availability
Basic supports password sign-in and individual two-factor authentication. Workspace-managed SAML single sign-on is available on Pro.

## Standard support
Basic includes email support with a two-business-day initial response target. Include the workspace name and a short description of the issue. Billing disputes and refund requests go to human review.` },
] as const;

export type Chunk = { id: string; title: string; text: string; tier: string; version: string };
export type Match = Chunk & { score: number };

export function chunkPolicy(policy: { id: string; tier: string; markdown: string }): Chunk[] {
  const [heading, ...sections] = policy.markdown.trim().split(/^## /m);
  return sections.flatMap(section => {
    const newline = section.indexOf('\n');
    const topic = section.slice(0, newline).trim();
    const words = section.slice(newline + 1).trim().split(/\s+/);
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
    const parts: string[] = [];
    // Approximate 350 tokens with 260 words and overlap only oversized sections.
    for (let start = 0; start < words.length; start += 235) {
      parts.push(words.slice(start, start + 260).join(' '));
      if (start + 260 >= words.length) break;
    }
    return parts.map((text, index) => ({
      id: `${policy.id}/${slug}${index ? `-${index + 1}` : ''}`,
      title: `${heading.replace(/^# /, '').trim()} / ${topic}`,
      text, tier: policy.tier, version: POLICY_VERSION,
    }));
  });
}

export const chunks = policies.flatMap(chunkPolicy);
