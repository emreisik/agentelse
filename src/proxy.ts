import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { isPublicPath } from "@/lib/public-paths";

export const proxy = auth((req) => {
  const { pathname } = req.nextUrl;
  const isPublic = isPublicPath(pathname);

  if (!req.auth && !isPublic) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
