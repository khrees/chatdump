import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  pressed?: boolean
  variant?: 'primary' | 'secondary'
}

const baseClass =
  'inline-flex items-center gap-[0.72rem] rounded-full font-mono text-[0.82rem] font-semibold uppercase tracking-[0.08em] transition-[box-shadow,transform,background,border-color] duration-[180ms] ease-out hover:enabled:-translate-y-px disabled:cursor-not-allowed disabled:opacity-55 disabled:transform-none max-[500px]:min-h-[2.9rem] max-[500px]:gap-[0.5rem] max-[500px]:text-[0.72rem] max-[500px]:tracking-[0.06em] max-[720px]:min-h-[3.15rem] max-[720px]:w-full max-[720px]:justify-between max-[720px]:gap-[0.58rem] max-[720px]:text-[0.78rem] max-[720px]:tracking-[0.07em]'

const variantClasses = {
  primary:
    'min-h-[3.2rem] w-fit justify-between border border-[rgba(23,20,17,0.18)] bg-[linear-gradient(135deg,#292520,#171411)] px-[1rem] pr-[0.36rem] py-[0.3rem] text-[#f5eee5] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_16px_24px_rgba(23,20,17,0.12)] hover:enabled:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_18px_28px_rgba(23,20,17,0.16)] max-[500px]:min-h-[2.85rem] max-[500px]:px-[0.8rem] max-[500px]:pr-[0.28rem] max-[720px]:px-[0.9rem] max-[720px]:pr-[0.32rem]',
  secondary:
    'min-h-12 border border-line-strong bg-white/72 px-4 py-[0.35rem] pl-[0.9rem] text-ink shadow-soft max-[500px]:px-[0.8rem] max-[500px]:pl-[0.75rem] max-[720px]:px-[0.95rem] max-[720px]:pl-[0.85rem]',
} as const

const pressedClass =
  'border-[rgba(155,106,51,0.28)] bg-[rgba(188,132,66,0.14)] shadow-[inset_0_1px_0_rgba(255,255,255,0.32),0_10px_24px_rgba(155,106,51,0.1)]'

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
