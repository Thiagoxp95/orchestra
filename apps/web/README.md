This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Update the production phone app

Production runs on the Mac and is accessed through Tailscale HTTPS on port
`8445`. Vercel is no longer the deployment target; pushing to GitHub or deploying
to Vercel does not update the phone app.

Follow the [private web update instructions](../../infra/tailscale/README.md#web-only-updates)
to build `.next-private` with the installed service's private backend settings
and restart `com.orchestra.private-web`. Local development uses a separate
`.next` build.

For initial setup, see [Tailscale setup](../../infra/tailscale/README.md).
