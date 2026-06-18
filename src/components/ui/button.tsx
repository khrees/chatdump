import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  pressed?: boolean
  variant?: 'primary' | 'secondary'
}

const baseClass =
  'inline-flex items-center gap-[0.72rem] rounded-lg font-mono text-[0.82rem] font-semibold uppercase tracking-[0.08em] transition-all duration-[180ms] ease-out hover:enabled:-translate-y-[2px] active:enabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 max-[500px]:min-h-[2.8rem] max-[500px]:gap-[0.5rem] max-[500px]:text-[0.72rem] max-[500px]:tracking-[0.06em] max-[720px]:min-h-[3.15rem] max-[720px]:w-full max-[720px]:justify-between max-[720px]:gap-[0.58rem] max-[720px]:text-[0.78rem] max-[720px]:tracking-[0.07em]'

const variantClasses = {
  primary:
    'min-h-[3.2rem] w-fit justify-between border border-teal/20 bg-teal px-[1rem] pr-[0.36rem] py-[0.3rem] text-white shadow-md hover:enabled:bg-teal-hover hover:enabled:shadow-lg max-[500px]:min-h-[2.85rem] max-[500px]:px-[0.8rem] max-[500px]:pr-[0.28rem] max-[720px]:px-[0.9rem] max-[720px]:pr-[0.32rem]',
  secondary:
    'min-h-12 border border-line-strong bg-paper-elevated px-4 py-[0.35rem] pl-[0.9rem] text-ink shadow-soft hover:enabled:bg-paper-raised max-[500px]:px-[0.8rem] max-[500px]:pl-[0.75rem] max-[720px]:px-[0.95rem] max-[720px]:pl-[0.85rem]',
} as const

const pressedClass =
  'border-teal/30 bg-teal/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_8px_16px_rgba(20,184,166,0.06)]'

export function Button({
  className,
  pressed = false,
  type = 'button',
  variant = 'secondary',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={cn(
        baseClass,
        variantClasses[variant],
        pressed && variant === 'secondary' && pressedClass,
        className,
      )}
    />
  )
}
