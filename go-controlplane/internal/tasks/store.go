// Package tasks owns the Redis read contract for task status snapshots.
package tasks

import (
	"context"
	"encoding/json"
	"errors"
)

type Getter interface {
	Get(ctx context.Context, key string) (value string, found bool, err error)
}

type Store struct {
	redis Getter
}

func NewStore(redis Getter) Store {
	return Store{redis: redis}
}

// GetForUser returns only a task owned by userID. The stored JSON remains the
// source of truth so this works with both Python and Go writers during cutover.
func (store Store) GetForUser(ctx context.Context, taskID, userID string) (map[string]any, bool, error) {
	if taskID == "" || userID == "" {
		return nil, false, errors.New("task_id and user_id are required")
	}
	raw, found, err := store.redis.Get(ctx, "task:"+taskID)
	if err != nil || !found {
		return nil, found, err
	}
	var task map[string]any
	if err := json.Unmarshal([]byte(raw), &task); err != nil {
		return nil, false, err
	}
	if owner, _ := task["_user_id"].(string); owner != userID {
		return nil, false, nil
	}
	return task, true, nil
}
