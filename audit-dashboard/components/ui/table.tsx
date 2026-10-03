"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

// The ONE data table. What it enforces that a bare <table> does not:
//   * the scroll container is a labelled, focusable region — a keyboard user can scroll a wide table
//     sideways, and a screen reader hears what the region is (`label` is REQUIRED);
//   * header cells default to scope="col" (override with scope="row" for row headers);
//   * numbers: pass `num` on a TableHead/TableCell for right-aligned tabular figures;
//   * no `whitespace-nowrap` by default — bilingual Thai/English cells must wrap, and a nowrap column
//     is what pushed tables wider than a phone. Add it per column where a value must not break.
function Table({
  className,
  containerClassName,
  label,
  ...props
}: React.ComponentProps<"table"> & {
  /** Accessible name of the scroll region, e.g. "PLEs ทั้งหมด / All PLEs". */
  label: string
  containerClassName?: string
}) {
  return (
    <div
      data-slot="table-container"
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn("relative w-full overflow-x-auto rounded-lg", containerClassName)}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({
  className,
  num,
  scope = "col",
  ...props
}: React.ComponentProps<"th"> & { num?: boolean }) {
  return (
    <th
      data-slot="table-head"
      scope={scope}
      className={cn(
        "h-10 px-2 align-middle font-medium text-foreground [&:has([role=checkbox])]:pr-0",
        num ? "text-right tabular-nums" : "text-left",
        className
      )}
      {...props}
    />
  )
}

function TableCell({
  className,
  num,
  ...props
}: React.ComponentProps<"td"> & { num?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle [&:has([role=checkbox])]:pr-0",
        num && "text-right tabular-nums",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
