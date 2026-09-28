"use client";
import { cn } from "@/lib/utils";
import React, { useContext, useRef, useState } from "react";
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  useAnimationControls,
} from "motion/react";

const DragConstraintContext = React.createContext<React.RefObject<HTMLDivElement | null> | null>(null);

export const DraggableCardBody = ({
  className,
  children,
  ariaLabel,
}: {
  className?: string;
  children?: React.ReactNode;
  ariaLabel: string;
}) => {
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const positionX = useMotionValue(0);
  const positionY = useMotionValue(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const constraintRef = useContext(DragConstraintContext);
  const controls = useAnimationControls();
  const [isDragging, setIsDragging] = useState(false);

  const springConfig = {
    stiffness: 100,
    damping: 20,
    mass: 0.5,
  };

  const rotateX = useSpring(
    useTransform(mouseY, [-300, 300], [25, -25]),
    springConfig,
  );
  const rotateY = useSpring(
    useTransform(mouseX, [-300, 300], [-25, 25]),
    springConfig,
  );

  const opacity = useSpring(
    useTransform(mouseX, [-300, 0, 300], [0.8, 1, 0.8]),
    springConfig,
  );

  const glareOpacity = useSpring(
    useTransform(mouseX, [-300, 0, 300], [0.2, 0, 0.2]),
    springConfig,
  );

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const { clientX, clientY } = e;
    const { width, height, left, top } =
      cardRef.current?.getBoundingClientRect() ?? {
        width: 0,
        height: 0,
        left: 0,
        top: 0,
      };
    const centerX = left + width / 2;
    const centerY = top + height / 2;
    const deltaX = clientX - centerX;
    const deltaY = clientY - centerY;
    mouseX.set(deltaX);
    mouseY.set(deltaY);
  };

  const handleMouseLeave = () => {
    mouseX.set(0);
    mouseY.set(0);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 16;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") {
      positionX.set(0);
      positionY.set(0);
      return;
    }
    const cardRect = cardRef.current?.getBoundingClientRect();
    const deckRect = constraintRef?.current?.getBoundingClientRect();
    if (!cardRect || !deckRect) return;
    const moveX = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const moveY = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    const currentX = positionX.get();
    const currentY = positionY.get();
    positionX.set(Math.min(currentX + (deckRect.right - cardRect.right), Math.max(currentX - (cardRect.left - deckRect.left), currentX + moveX)));
    positionY.set(Math.min(currentY + (deckRect.bottom - cardRect.bottom), Math.max(currentY - (cardRect.top - deckRect.top), currentY + moveY)));
  };

  return (
    <motion.div
      ref={cardRef}
      role="group"
      aria-label={ariaLabel}
      tabIndex={0}
      drag
      dragConstraints={constraintRef ?? cardRef}
      dragElastic={0.06}
      dragMomentum={false}
      onDragStart={() => {
        setIsDragging(true);
        document.body.style.cursor = "grabbing";
      }}
      onDragEnd={() => {
        setIsDragging(false);
        document.body.style.cursor = "default";

        controls.start({
          rotateX: 0,
          rotateY: 0,
          transition: {
            type: "spring",
            ...springConfig,
          },
        });
      }}
      style={{
        x: positionX,
        y: positionY,
        rotateX,
        rotateY,
        opacity,
        zIndex: isDragging ? 30 : undefined,
        touchAction: "none",
        WebkitUserSelect: "none",
        userSelect: "none",
        willChange: "transform",
      }}
      animate={controls}
      whileHover={{ scale: 1.02 }}
      whileFocus={{ scale: 1.02 }}
      onKeyDown={handleKeyDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={cn(
        "relative min-h-96 w-80 overflow-hidden rounded-md bg-neutral-100 p-6 shadow-2xl transform-3d dark:bg-neutral-900",
        className,
      )}
    >
      {children}
      <motion.div
        style={{
          opacity: glareOpacity,
        }}
        className="pointer-events-none absolute inset-0 bg-white select-none"
      />
    </motion.div>
  );
};

export const DraggableCardContainer = ({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <DragConstraintContext.Provider value={containerRef}>
      <div ref={containerRef} className={cn("[perspective:3000px]", className)}>{children}</div>
    </DragConstraintContext.Provider>
  );
};
