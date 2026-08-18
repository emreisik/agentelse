"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { signIn } from "next-auth/react";
import { z } from "zod";
import {
  AlertCircle,
  Briefcase,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  User,
} from "lucide-react";

import { registerAction } from "@/server/actions/auth-actions";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const schema = z.object({
  name: z.string().min(1, "Name is required"),
  workspaceName: z.string().min(1, "Company/team name is required"),
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export function RegisterForm({ callbackUrl }: { callbackUrl: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", workspaceName: "", email: "", password: "" },
  });

  async function onSubmit(values: z.infer<typeof schema>) {
    setSubmitting(true);
    setError(null);

    const result = await registerAction(values);
    if (!result.ok) {
      setSubmitting(false);
      setError(result.error);
      return;
    }

    const signInResult = await signIn("credentials", {
      email: values.email,
      password: values.password,
      redirect: false,
    });

    setSubmitting(false);

    if (signInResult?.error) {
      // Account was created but automatic sign-in failed — the user can try
      // manually from the login page, no need to register again.
      router.push("/login");
      return;
    }

    router.push(callbackUrl);
    router.refresh();
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 text-center">
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
          Create your account
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Start with your first brand, set up in minutes
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-medium">Full Name</FormLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <User />
                  </InputGroupAddon>
                  <FormControl>
                    <InputGroupInput
                      type="text"
                      autoComplete="name"
                      autoFocus
                      placeholder="Jane Doe"
                      {...field}
                    />
                  </FormControl>
                </InputGroup>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="workspaceName"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-medium">
                  Company / Team Name
                </FormLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <Briefcase />
                  </InputGroupAddon>
                  <FormControl>
                    <InputGroupInput
                      type="text"
                      autoComplete="organization"
                      placeholder="Agency Name"
                      {...field}
                    />
                  </FormControl>
                </InputGroup>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-medium">Email</FormLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <Mail />
                  </InputGroupAddon>
                  <FormControl>
                    <InputGroupInput
                      type="email"
                      autoComplete="email"
                      placeholder="example@agency.com"
                      {...field}
                    />
                  </FormControl>
                </InputGroup>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-medium">Password</FormLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <Lock />
                  </InputGroupAddon>
                  <FormControl>
                    <InputGroupInput
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder="••••••••"
                      {...field}
                    />
                  </FormControl>
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      type="button"
                      size="icon-xs"
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOff /> : <Eye />}
                      <span className="sr-only">
                        {showPassword ? "Hide password" : "Show password"}
                      </span>
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <FormMessage />
              </FormItem>
            )}
          />

          {error ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Registration failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <Button
            type="submit"
            size="lg"
            className="h-11 w-full text-base"
            disabled={submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="animate-spin" />
                Creating account…
              </>
            ) : (
              "Create account"
            )}
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link
              href="/login"
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              Sign in
            </Link>
          </p>
        </form>
      </Form>
    </div>
  );
}
