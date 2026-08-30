"use client"

import * as React from "react"

/*
 * Theme toggle — README §Layout shell item 8: a 30×30 icon button, ☾ in
 * dark, ☀ in light. Theme cascades from the single root attribute
 * [data-sds-theme] (README §Design tokens: never threaded through props) —
 * this toggle sets it on documentElement; tokens.css carries the values.
 * Focus ring: 2px --info, offset 2 (README §Focus).
 */
function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = React.useState<"dark" | "light">("dark")

  React.useEffect(() => {
    const current = document.documentElement.getAttribute("data-sds-theme")
    if (current === "light" || current === "dark") setTheme(current)
  }, [])

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark"
    setTheme(next)
    document.documentElement.setAttribute("data-sds-theme", next)
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      className={
        "inline-flex size-[30px] shrink-0 items-center justify-center rounded-sm text-[14px] leading-none text-text-2 transition-colors duration-100 hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info " +
        (className ?? "")
      }
    >
      {theme === "dark" ? "☾" : "☀"}
    </button>
  )
}

export { ThemeToggle }
