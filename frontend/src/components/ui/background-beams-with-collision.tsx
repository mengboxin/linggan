"use client";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence, useInView, useReducedMotion } from "motion/react";
import React, { useRef, useState, useEffect, useMemo } from "react";

export function getCollisionPoint(
  parent: HTMLElement,
  beam: HTMLElement,
  collisionFloor: HTMLElement,
) {
  const parentRect = parent.getBoundingClientRect();
  const beamRect = beam.getBoundingClientRect();
  const floorRect = collisionFloor.getBoundingClientRect();
  const scaleX = parentRect.width ? parent.offsetWidth / parentRect.width : 1;
  const scaleY = parentRect.height ? parent.offsetHeight / parentRect.height : 1;

  return {
    x: (beamRect.left + beamRect.width / 2 - parentRect.left) * scaleX,
    y: (floorRect.top - parentRect.top) * scaleY,
  };
}

export const BackgroundBeamsWithCollision = ({
  children,
  className,
  beamClassName,
  collisionClassName,
}: {
  children: React.ReactNode;
  className?: string;
  beamClassName?: string;
  collisionClassName?: string;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(parentRef, { amount: 0.05 });
  const prefersReducedMotion = useReducedMotion();
  const animationsEnabled = isInView && !prefersReducedMotion;

  const beams = [
    {
      initialX: 10,
      translateX: 10,
      duration: 5.2,
      repeatDelay: 1.2,
      delay: 0.2,
    },
    {
      initialX: 180,
      translateX: 180,
      duration: 4.4,
      repeatDelay: 1.6,
      delay: 1.1,
    },
    {
      initialX: 340,
      translateX: 340,
      duration: 6.1,
      repeatDelay: 1.1,
      delay: 0.5,
      className: "h-6",
    },
    {
      initialX: 510,
      translateX: 510,
      duration: 4.8,
      repeatDelay: 1.7,
      delay: 1.8,
    },
    {
      initialX: 680,
      translateX: 680,
      duration: 7.2,
      repeatDelay: 1.4,
      delay: 0.8,
      className: "h-20",
    },
    {
      initialX: 840,
      translateX: 840,
      duration: 4.1,
      repeatDelay: 1.3,
      delay: 2.2,
      className: "h-12",
    },
    {
      initialX: 1010,
      translateX: 1010,
      duration: 5.7,
      repeatDelay: 1.5,
      delay: 0.4,
      className: "h-6",
    },
    { initialX: 1180, translateX: 1180, duration: 4.6, repeatDelay: 1.8, delay: 1.4 },
    { initialX: 1320, translateX: 1320, duration: 6.6, repeatDelay: 1.2, delay: 2.5, className: "h-8" },
  ];

  return (
    <div
      ref={parentRef}
      className={cn(
        "h-96 md:h-[40rem] bg-gradient-to-b from-white to-neutral-100 dark:from-neutral-950 dark:to-neutral-800 relative flex items-center w-full justify-center overflow-hidden",
        // h-screen if you want bigger
        className
      )}
    >
      {beams.map((beam) => (
        <CollisionMechanism
          key={beam.initialX + "beam-idx"}
          beamOptions={beam}
          containerRef={containerRef}
          parentRef={parentRef}
          active={animationsEnabled}
          beamClassName={beamClassName}
          collisionClassName={collisionClassName}
        />
      ))}

      {children}
      <div
        ref={containerRef}
        className="linggan-v2-hero-collision-floor absolute bottom-0 bg-neutral-100 w-full inset-x-0 pointer-events-none"
        style={{
          boxShadow: "0 18px 48px rgba(34, 42, 53, 0.08)",
        }}
      ></div>
    </div>
  );
};

const CollisionMechanism = React.forwardRef<
  HTMLDivElement,
  {
    containerRef: React.RefObject<HTMLDivElement | null>;
    parentRef: React.RefObject<HTMLDivElement | null>;
      active: boolean;
      beamClassName?: string;
      collisionClassName?: string;
    beamOptions?: {
      initialX?: number;
      translateX?: number;
      initialY?: number;
      translateY?: number;
      rotate?: number;
      className?: string;
      duration?: number;
      delay?: number;
      repeatDelay?: number;
    };
  }
>(({ parentRef, containerRef, active, beamOptions = {}, beamClassName, collisionClassName }, ref) => {
  const beamRef = useRef<HTMLDivElement>(null);
  const [collision, setCollision] = useState<{
    detected: boolean;
    coordinates: { x: number; y: number } | null;
  }>({
    detected: false,
    coordinates: null,
  });
  const [beamKey, setBeamKey] = useState(0);
  const [collisionPoint, setCollisionPoint] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const parent = parentRef.current;
    const beam = beamRef.current;
    const collisionFloor = containerRef.current;
    if (!parent || !beam || !collisionFloor) return;

    // Motion transforms do not affect offsetLeft, so use rendered positions.
    const updatePoint = () => {
      setCollisionPoint(getCollisionPoint(parent, beam, collisionFloor));
    };
    updatePoint();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updatePoint);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [beamKey, containerRef, parentRef]);

  useEffect(() => {
    if (!active || !collisionPoint || !beamRef.current) return;
    const beam = beamRef.current;
    const initialY = Number.parseFloat(String(beamOptions.initialY ?? "-200px"));
    const targetY = Number.parseFloat(String(beamOptions.translateY ?? "1800px"));
    const startBottom = beam.offsetTop + beam.offsetHeight + initialY;
    const travel = targetY - initialY;
    const progress = Math.max(0, Math.min(1, (collisionPoint.y - startBottom) / travel));
    const delay = ((beamOptions.delay ?? 0) + (beamOptions.duration ?? 8) * progress) * 1000;

    const timer = window.setTimeout(() => {
      setCollision({ detected: true, coordinates: collisionPoint });
    }, delay);

    return () => window.clearTimeout(timer);
  }, [active, beamKey, beamOptions.delay, beamOptions.duration, beamOptions.initialY, beamOptions.translateY, collisionPoint]);

  useEffect(() => {
    if (collision.detected && collision.coordinates) {
      const collisionResetTimer = window.setTimeout(() => {
        setCollision({ detected: false, coordinates: null });
      }, 2000);

      const beamResetTimer = window.setTimeout(() => {
        setBeamKey((prevKey) => prevKey + 1);
      }, 2000);

      return () => {
        window.clearTimeout(collisionResetTimer);
        window.clearTimeout(beamResetTimer);
      };
    }
  }, [collision]);

  return (
    <>
      <motion.div
        key={beamKey}
        ref={beamRef}
        animate={active ? "animate" : "idle"}
        initial="idle"
        variants={{
          idle: {
            translateY: beamOptions.initialY || "-200px",
            translateX: beamOptions.initialX || "0px",
            rotate: beamOptions.rotate || 0,
          },
          animate: {
            translateY: beamOptions.translateY || "1800px",
            translateX: beamOptions.translateX || "0px",
            rotate: beamOptions.rotate || 0,
          },
        }}
        transition={{
          duration: beamOptions.duration || 8,
          ease: "linear",
          delay: beamOptions.delay || 0,
          repeatDelay: beamOptions.repeatDelay || 0,
        }}
        className={cn(
          "absolute left-0 top-20 m-auto h-14 w-px rounded-full bg-gradient-to-t from-indigo-500 via-purple-500 to-transparent",
          beamOptions.className,
          beamClassName,
        )}
      />
      <AnimatePresence>
        {collision.detected && collision.coordinates && (
          <Explosion
            key={`${collision.coordinates.x}-${collision.coordinates.y}`}
            className={collisionClassName}
            style={{
              left: `${collision.coordinates.x}px`,
              top: `${collision.coordinates.y}px`,
              transform: "translate(-50%, -50%)",
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
});

CollisionMechanism.displayName = "CollisionMechanism";

const Explosion = ({ ...props }: React.HTMLProps<HTMLDivElement>) => {
  const spans = useMemo(() => Array.from({ length: 20 }, (_, index) => ({
    id: index,
    initialX: 0,
    initialY: 0,
    directionX: Math.floor(Math.random() * 80 - 40),
    directionY: Math.floor(Math.random() * -50 - 10),
  })), []);

  return (
    <div {...props} className={cn("absolute z-50 h-2 w-2", props.className)}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 1.5, ease: "easeOut" }}
        className="absolute -inset-x-10 top-0 m-auto h-2 w-10 rounded-full bg-gradient-to-r from-transparent via-indigo-500 to-transparent blur-sm"
      ></motion.div>
      {spans.map((span) => (
        <motion.span
          key={span.id}
          initial={{ x: span.initialX, y: span.initialY, opacity: 1 }}
          animate={{
            x: span.directionX,
            y: span.directionY,
            opacity: 0,
          }}
          transition={{ duration: Math.random() * 1.5 + 0.5, ease: "easeOut" }}
          className="absolute h-1 w-1 rounded-full bg-gradient-to-b from-indigo-500 to-purple-500"
        />
      ))}
    </div>
  );
};
