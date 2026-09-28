package tasks

import (
	"context"
	"errors"
	"testing"
)

type fakeGetter struct {
	value string
	found bool
	err   error
}

func (getter fakeGetter) Get(context.Context, string) (string, bool, error) {
	return getter.value, getter.found, getter.err
}

func TestGetForUserEnforcesTaskOwnership(t *testing.T) {
	store := NewStore(fakeGetter{value: `{"status":"completed","_user_id":"user-1"}`, found: true})
	task, found, err := store.GetForUser(context.Background(), "task-1", "user-1")
	if err != nil || !found || task["status"] != "completed" {
		t.Fatalf("unexpected owned task result task=%v found=%v err=%v", task, found, err)
	}
	_, found, err = store.GetForUser(context.Background(), "task-1", "user-2")
	if err != nil || found {
		t.Fatalf("expected foreign task to be hidden found=%v err=%v", found, err)
	}
}

func TestGetForUserPropagatesStorageFailure(t *testing.T) {
	store := NewStore(fakeGetter{err: errors.New("redis unavailable")})
	_, _, err := store.GetForUser(context.Background(), "task-1", "user-1")
	if err == nil {
		t.Fatal("expected storage error")
	}
}
