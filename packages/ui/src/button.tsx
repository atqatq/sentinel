import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "./lib/utils"

/*
 * Vendored from shadcn/ui (new-york), MIT — see NOTICE.md in this package.
 *
 * Adaptations from the upstream source (all A12-mandated: SDS is the design
 * source of truth, and the design handoff README wins on rendered detail):
 *   - `@/lib/utils` import path → relative, for the vendored home.
 *   - Semantic classes bound to SDS tokens via the @theme mapping:
 *       primary button  → --text fill with --inv label (README neutrals table)
 *       destructive     → --critical (documented interpretation; see NOTICE)
 *       outline/ghost/secondary chrome → --line-strong / --hover (README)
 *       focus ring      → --info (README: focus ring is info)
 *   - Controls radius → rounded-sm (SDS radius-sm 6px: "controls, inputs").
 * Upstream keeps: variants API, sizes, Slot/asChild, data-slot attribute.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-info focus-visible:ring-info/50 focus-visible:ring-[3px] aria-invalid:ring-critical/20 aria-invalid:border-critical",
  {
    variants: {
      variant: {
        default:
          "bg-text text-inv hover:bg-text/90",
        destructive:
          "bg-critical text-inv hover:bg-critical/90 focus-visible:ring-critical/30",
        outline:
          "border border-line-strong bg-surface hover:bg-hover hover:text-text",
        secondary:
          "bg-hover text-text hover:bg-hover/80",
        ghost:
          "hover:bg-hover hover:text-text",
        link: "text-info underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-sm gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-sm px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
