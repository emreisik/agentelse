"use client"

import * as React from "react"
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"

import { cn } from "@/lib/utils"

// Centered dialog over Base UI's Drawer. Unlike Sheet (Dialog based) it is
// aware of the software keyboard and of the Android back gesture. It opens in
// the middle of the screen: nothing is anchored to the bottom edge, so there is
// no slide, no overscroll bleed and no swipe (the popup is a swipe-ignore
// region as a whole).

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
// Colours are the caller's (className); the height is constant so the dialog
// never jumps between steps. --bleed stays defined (0) for callers that still
// add it to a bottom padding.
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
          className="fixed inset-0 z-50 min-h-dvh bg-black opacity-(--backdrop-opacity) transition-opacity duration-200 ease-out [--backdrop-opacity:0.45] data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none supports-[-webkit-touch-callout:none]:absolute dark:[--backdrop-opacity:0.7]"
        />
        <DrawerPrimitive.Viewport
          data-slot="drawer-viewport"
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
        >
          <DrawerPrimitive.Popup
            data-slot="drawer-content"
            data-base-ui-swipe-ignore=""
            initialFocus={initialFocus}
            finalFocus={finalFocus}
            className={cn(
              "relative z-1 flex h-[40rem] max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-xl outline-none [--bleed:0px] transition-[opacity,scale] duration-200 ease-out data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none",
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
// swipe (the popup itself is swipe-ignore too; this stays for callers that
// render the body on its own).
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
