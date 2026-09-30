"use client"

import * as React from "react"
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"

import { cn } from "@/lib/utils"

// Bottom drawer over Base UI's Drawer. Unlike Sheet (Dialog based) it is
// aware of the software keyboard and of the Android back gesture.

function Drawer({ ...props }: DrawerPrimitive.Root.Props) {
  return (
    <DrawerPrimitive.Root
      data-slot="drawer"
      swipeDirection="down"
      {...props}
    />
  )
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}

// Order matters: keyboard provider > portal > backdrop + viewport > popup.
// Colours are the caller's (className); the height is constant so the sheet
// never jumps between steps. --bleed keeps it flush on iOS overscroll.
function DrawerContent({
  className,
  children,
  initialFocus,
  finalFocus,
  ...props
}: DrawerPrimitive.Popup.Props) {
  return (
    <DrawerPrimitive.VirtualKeyboardProvider>
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Backdrop
          data-slot="drawer-overlay"
          className="fixed inset-0 z-50 min-h-dvh bg-black opacity-[calc(var(--backdrop-opacity)*(1-var(--drawer-swipe-progress,0)))] transition-opacity duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] [--backdrop-opacity:0.45] data-ending-style:opacity-0 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-starting-style:opacity-0 data-swiping:duration-0 motion-reduce:transition-none supports-[-webkit-touch-callout:none]:absolute dark:[--backdrop-opacity:0.7]"
        />
        <DrawerPrimitive.Viewport
          data-slot="drawer-viewport"
          className="fixed inset-0 z-50 flex touch-none items-end justify-center [--bleed:3rem] after:pointer-events-none after:fixed after:inset-x-0 after:bottom-0 after:h-[var(--bleed)] after:bg-popover after:content-[''] data-closed:after:opacity-0 has-[[data-swiping]]:after:opacity-0"
        >
          <DrawerPrimitive.Popup
            data-slot="drawer-content"
            initialFocus={initialFocus}
            finalFocus={finalFocus}
            className={cn(
              "relative z-1 -mb-[var(--bleed)] flex h-[calc(min(38rem,100dvh-1.5rem)+var(--bleed))] w-full max-w-xl touch-none flex-col overflow-visible rounded-t-2xl border-t bg-popover text-popover-foreground shadow-lg outline-none [--bleed:3rem] [transform:translateY(var(--drawer-swipe-movement-y))] transition-[transform,box-shadow] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-ending-style:[transform:translateY(calc(100%-var(--bleed)+2px))] data-starting-style:[transform:translateY(calc(100%-var(--bleed)+2px))] data-swiping:select-none motion-reduce:transition-none sm:border-x",
              className
            )}
            {...props}
          >
            {children}
          </DrawerPrimitive.Popup>
        </DrawerPrimitive.Viewport>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.VirtualKeyboardProvider>
  )
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn(
        "font-heading text-base font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

function DrawerDescription({
  className,
  ...props
}: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

// The scroller: swipe-ignore so scrolling or tapping rows never starts a
// swipe (only the header can).
function DrawerBody({ className, ...props }: DrawerPrimitive.Content.Props) {
  return (
    <DrawerPrimitive.Content
      data-slot="drawer-body"
      data-base-ui-swipe-ignore=""
      className={cn(
        "min-h-0 flex-1 touch-auto overflow-y-auto overscroll-contain any-pointer-coarse:text-base",
        className
      )}
      {...props}
    />
  )
}

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
  DrawerBody,
}
