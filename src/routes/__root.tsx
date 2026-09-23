/// <reference types="vite/client" />
import type { ReactNode } from 'react'
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import '@fontsource-variable/geist'
import '../styles.css'

const SITE_TITLE = 'chatdump | Public Share Link to Markdown'
const SITE_DESCRIPTION =
  'Convert ChatGPT, Claude, Copilot, Gemini, and Grok share links into clean, deterministic Markdown.'
const SITE_URL = 'https://chatdump.khrees.com'
const SOCIAL_IMAGE = `${SITE_URL}/social-card.svg`

export const Route = createRootRoute({
  notFoundComponent: NotFoundComponent,
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: SITE_TITLE,
      },
      {
        name: 'description',
        content: SITE_DESCRIPTION,
      },
      {
        property: 'og:type',
        content: 'website',
      },
      {
        property: 'og:site_name',
        content: SITE_TITLE,
      },
      {
        property: 'og:title',
        content: SITE_TITLE,
      },
      {
        property: 'og:description',
        content: SITE_DESCRIPTION,
      },
      {
        property: 'og:url',
        content: SITE_URL,
      },
      {
        property: 'og:image',
        content: SOCIAL_IMAGE,
      },
      {
        property: 'og:image:width',
        content: '1200',
      },
      {
        property: 'og:image:height',
        content: '630',
      },
      {
        property: 'twitter:card',
        content: 'summary_large_image',
      },
      {
        property: 'twitter:title',
        content: SITE_TITLE,
      },
      {
        property: 'twitter:description',
        content: SITE_DESCRIPTION,
      },
      {
        property: 'twitter:image',
        content: SOCIAL_IMAGE,
      },
    ],
    links: [
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/favicon.svg',
        sizes: 'any',
      },
      {
        rel: 'apple-touch-icon',
        href: '/logo-mark.svg',
      },
      {
        rel: 'preconnect',
        href: 'https://fonts.googleapis.com',
      },
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:ital,wght@0,400..700;1,400..700&display=swap',
      },
    ],
  }),
  component: RootComponent,
})

function NotFoundComponent() {
  return (
    <main className="app-frame grid place-items-center">
      <section className="panel-shell grid w-full max-w-[42rem] gap-6 p-6 max-[720px]:gap-5 max-[720px]:rounded-[1.5rem] max-[720px]:p-4">
        <div className="grid gap-3">
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[rgba(49,67,58,0.12)] bg-[rgba(255,255,255,0.54)] px-3 py-1.5 font-mono text-[0.72rem] uppercase tracking-[0.12em] text-ink-soft shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent" />
            Route missing
          </div>

          <div className="grid gap-3">
            <h1 className="text-[clamp(2.3rem,5vw,4rem)] font-bold leading-[0.98] tracking-[-0.07em] max-[720px]:text-[clamp(2rem,11vw,3rem)]">
              This page wandered off.
            </h1>
            <p className="max-w-[34rem] text-[1.02rem] leading-[1.72] text-ink-muted max-[720px]:text-[0.97rem]">
              The link you opened does not map to a known route. Return to the
              home screen to convert a share link into Markdown.
            </p>
          </div>
        </div>

        <Link
          className="inline-flex min-h-[3.2rem] w-fit items-center gap-[0.72rem] rounded-full border border-[rgba(23,20,17,0.18)] bg-[linear-gradient(135deg,#292520,#171411)] px-[1rem] pr-[0.36rem] py-[0.3rem] font-mono text-[0.82rem] font-semibold uppercase tracking-[0.08em] text-[#f5eee5] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_16px_24px_rgba(23,20,17,0.12)] transition-[box-shadow,transform,background,border-color] duration-[180ms] ease-out hover:-translate-y-px hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_18px_28px_rgba(23,20,17,0.16)] max-[720px]:w-full max-[720px]:justify-between max-[720px]:gap-[0.58rem] max-[720px]:px-[0.9rem] max-[720px]:pr-[0.32rem] max-[720px]:text-[0.78rem] max-[720px]:tracking-[0.07em]"
          to="/"
        >
          <span>Return home</span>
          <svg aria-hidden="true" className="h-8 w-8 rounded-full bg-white/8 p-[0.45rem] max-[720px]:h-7 max-[720px]:w-7" viewBox="0 0 24 24">
            <path
              d="M7 12h10M13 6l6 6-6 6"
              className="fill-none stroke-current stroke-2 stroke-linecap-round stroke-linejoin-round"
            />
          </svg>
        </Link>
      </section>
    </main>
  )
}

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
