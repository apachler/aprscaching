# Send mail

This page is for the sysop. It shows how to let the instance send mail: sign-in links, address confirmations
and the watch digest. At the end a test mail has reached your inbox.

## Before you start

- A sender address on a domain you control, for example `noreply@aprs.example.net`.
- One way to send from it: an SMTP server (your own, or a hosted mailbox) or a Resend account.
- A shell on the gateway host, and the instance's `OPERATOR_SECRET` for the test.

## Choose the transport

The gateway picks one transport, by this rule:

1. `SMTP_HOST` set: mail goes out over that SMTP server.
2. Else `EMAIL_API_KEY` set: mail goes out over the Resend API.
3. Else no mail. Members sign in with passkeys, or with a [one-time link](sign-in-links.md) you mint.

`EMAIL_FROM` is the sender for both transports. Without it the instance sends no mail.

## Steps

1. Run the wizard and answer the mail question, or set the keys in `deploy/.env` yourself:

    ```bash
    cd deploy && ./setup.sh
    ```

    For a hosted mailbox the settings are typically port 587, STARTTLS, and the full address as the login:

    ```bash
    EMAIL_FROM='aprscaching <noreply@aprs.example.net>'
    SMTP_HOST=mail.example.net
    SMTP_PORT=587
    SMTP_SECURE=starttls
    SMTP_USER=noreply@aprs.example.net
    SMTP_PASS='the mailbox password'
    ```

    Port 465 takes `SMTP_SECURE=tls`; it is the default there. `none` sends in the clear: use it only for a
    relay on the same box or a trusted LAN. For Resend, set `EMAIL_FROM` and `EMAIL_API_KEY` instead, and
    leave `SMTP_HOST` unset. Without the wizard, `./setup.sh --non-interactive --mail smtp …` takes the same
    answers as flags ([CLI](../../reference/cli.md#deploy-aprscaching)).

2. Publish SPF, DKIM and DMARC records for the sender's domain that name the server you send through. Your
   mail provider lists the records to add. Without them, receiving servers file the mail as spam or refuse
   it.
3. Restart the gateway so it reads the new settings: `docker compose up -d` in `deploy/`.

## Send a test mail

```bash
docker compose exec gateway node tools/admin/mail-test.mjs you@example.net                    # Docker stack, from deploy/
BASE=http://127.0.0.1:8787 OPERATOR_SECRET=… node tools/admin/mail-test.mjs you@example.net     # from a checkout
```

The tool asks the gateway to send one mail over its transport. It prints the transport on success. On a
refusal it prints the server's reason, such as `EAUTH 535 authentication failed` for a wrong password or
`ETIMEDOUT` for a server that does not answer. The gateway gives up on a silent server after 10 seconds, so a
dead mail server never holds a sign-in for long.

## Check that it worked

- The test mail is in your inbox, not in the spam folder.
- `deploy/aprscaching doctor` names the transport under `mail.transport`, and `mail.smtp` passes when the
  SMTP server answers ([Troubleshooting](../troubleshooting.md#mailtransport)).
- **Instance admin → Setup** shows *Email delivery* as met, with the transport.
- `/privacy` names the mail server's host as a recipient of members' addresses
  ([A public instance's duties](../compliance/index.md#name-the-operator)).

## Next

- [One-time sign-in links](sign-in-links.md): the way in when the instance sends no mail.
- [Secrets and credentials](../../reference/secrets.md): where `SMTP_PASS` lives and who must never hold it.
