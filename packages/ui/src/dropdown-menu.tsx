"use client"

import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"

import { cn } from "./lib/utils"

/*
 * Vendored from shadcn/ui (new-york), MIT — see NOTICE.md in this package.
 * Trimmed to what the SDS shell needs (Root/Trigger/Content/Item + Portal):
 * the menubar's dropdowns carry no checkable or sub-menu items yet, and A12
 * keeps the vendored surface minimal and reviewed.
 *
 * SDS adaptations (the handoff wins on rendered detail):
 *   - panel: --raised, 1px --line-strong, radius 10 (--sds-radius-md),
 *     popover shadow, 6px padding, min-width 264px, z-index 80
 *   - items: 13px, 7px 9px padding, radius 6, --hover fill
 *   - entering: 120ms fade-and-4px-rise (keyframes sds-pop-in in the theme
 *     css; prefers-reduced-motion override lives with the app globals)
 *   - focus ring: --info (README §Focus)
 */

const DropdownMenu = DropdownMenuPrimitive.Root
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
const DropdownMenuPortal = DropdownMenuPrimitive.Portal

const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-80 min-w-[264px] overflow-hidden rounded-md border border-line-strong bg-raised p-1.5 text-text shadow-popover",
        "data-[state=open]:animate-[sds-pop-in_120ms_cubic-bezier(0.2,0,0,1)]",
        className
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
))
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2 rounded-sm px-[9px] py-[7px] text-[13px] leading-none outline-none transition-colors duration-100 focus:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
      className
    )}
    {...props}
  />
))
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuPortal, DropdownMenuContent, DropdownMenuItem }
